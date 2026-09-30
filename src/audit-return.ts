import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { WebLaunchBrowserController } from "./web-launch-browser.js";

export const HEX_64_PATTERN = /^[0-9a-f]{64}$/i;
export const DEFAULT_AUDIT_CONCURRENCY = 3;
export const MAX_AUDIT_CONCURRENCY = 4;
export const MIN_AUDIT_CONCURRENCY = 1;

export const auditFindingSchema = z
  .object({
    claim: z.string().min(1).max(2_000),
    evidence_quote: z.string().min(1).max(4_000),
  })
  .strict();

export const auditResultSchema = z
  .object({
    summary: z.string().min(1).max(5_000),
    findings: z.array(auditFindingSchema).min(1).max(50),
    uncertainties: z.array(z.string().min(1).max(2_000)),
  })
  .strict();

export interface AuditStartInput {
  jobId: string;
  evidencePacket: string;
  evidenceSha256: string;
  packetSha256: string;
  collectManifest?: string;
}

export interface AuditSubmitInput {
  challenge: string;
  job_id?: string;
  evidence_sha256?: string;
  packet_sha256?: string;
  result: z.infer<typeof auditResultSchema>;
}

export interface RetainedAudit {
  audit_id: string;
  job_id: string;
  status: "succeeded";
  execution_surface: "chatgpt_web" | "chatshare";
  declared_model: "gpt-5.6-sol";
  api_mode: false;
  evidence_sha256: string;
  packet_sha256: string;
  collect_manifest: string | null;
  result: z.infer<typeof auditResultSchema>;
  started_at: string;
  completed_at: string;
}

export interface AuditBinding {
  auditId: string;
  jobId: string;
  evidenceSha256: string;
  packetSha256: string;
  collectManifest?: string;
  startedAt: string;
}

export interface BatchAuditJobInput {
  jobId: string;
  evidencePacket: string;
  evidenceSha256: string;
  packetSha256: string;
  collectManifest?: string;
}

export interface RetainedAuditBatch {
  [key: string]: unknown;
  batch_id: string;
  total_jobs: number;
  concurrency: number;
  status: "running" | "succeeded" | "failed";
  succeeded_jobs: number;
  failed_jobs: number;
  pending_jobs: number;
  batch_aggregate_sha256?: string;
  jobs: Array<{
    job_id: string;
    audit_id?: string;
    challenge?: string;
    status: "pending" | "running" | "succeeded" | "failed";
    evidence_sha256: string;
    packet_sha256: string;
    collect_manifest?: string;
    result?: z.infer<typeof auditResultSchema>;
    error?: string;
  }>;
  started_at: string;
  completed_at?: string;
}

function sha256Json(value: unknown): string {
  const stableStringify = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
    if (v && typeof v === "object" && v !== null) {
      return `{${Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(v);
  };
  return createHash("sha256").update(Buffer.from(stableStringify(value), "utf8")).digest("hex");
}

export function buildAuditPrompt(input: {
  challenge: string;
  jobId: string;
  evidenceSha256: string;
  packetSha256: string;
  evidencePacketText: string;
}): string {
  return [
    "You are performing a strict evidence-bound quantitative audit.",
    "",
    "CRITICAL CONSTRAINTS:",
    "1. Use ONLY the supplied evidence packet below. Do NOT perform any web search or external retrieval.",
    "2. Do NOT introduce assumptions or external market knowledge.",
    "3. If evidence is insufficient to verify any claim, state it explicitly in uncertainties.",
    "",
    "EVIDENCE PACKET:",
    input.evidencePacketText,
    "",
    "When complete, call DevSpace MCP tool `audit_submit` exactly once with:",
    JSON.stringify(
      {
        challenge: input.challenge,
        job_id: input.jobId,
        evidence_sha256: input.evidenceSha256,
        packet_sha256: input.packetSha256,
        result: {
          summary: "<1-2 sentence evidence summary>",
          findings: [
            {
              claim: "<verified business or catalyst claim>",
              evidence_quote: "<verbatim quote from evidence text>",
            },
          ],
          uncertainties: ["<any unverified claims or information gaps>"],
        },
      },
      null,
      2,
    ),
  ].join("\n");
}

export class AuditReturnController {
  readonly #browser: Pick<WebLaunchBrowserController, "launchWebConversation"> &
    Partial<Pick<WebLaunchBrowserController, "stopWebConversationRecovery">>;
  readonly #now: () => Date;
  readonly #executionSurface: "chatgpt_web" | "chatshare";
  readonly #bindingsByAuditId = new Map<string, AuditBinding>();
  readonly #auditIdByChallenge = new Map<string, string>();
  readonly #challengeByAuditId = new Map<string, string>();
  readonly #retainedByAuditId = new Map<string, RetainedAudit>();
  readonly #batchesById = new Map<string, RetainedAuditBatch>();
  readonly #batchIdByAuditId = new Map<string, string>();
  readonly #batchJobsById = new Map<string, BatchAuditJobInput[]>();
  readonly #conversationIdentityByAuditId = new Map<string, string>();

  constructor(
    browser: Pick<WebLaunchBrowserController, "launchWebConversation"> &
      Partial<Pick<WebLaunchBrowserController, "stopWebConversationRecovery">>,
    options: {
      now?: () => Date;
      executionSurface?: "chatgpt_web" | "chatshare";
    } = {},
  ) {
    this.#browser = browser;
    this.#now = options.now ?? (() => new Date());
    this.#executionSurface = options.executionSurface ?? "chatgpt_web";
  }

  async startAudit(input: AuditStartInput): Promise<{
    auditId: string;
    challenge: string;
    status: "pending";
    startedAt: string;
  }> {
    if (!HEX_64_PATTERN.test(input.evidenceSha256)) {
      throw new Error("evidenceSha256 must be a 64-character hex string");
    }
    if (!HEX_64_PATTERN.test(input.packetSha256)) {
      throw new Error("packetSha256 must be a 64-character hex string");
    }
    if (!input.jobId || input.jobId.trim().length === 0) {
      throw new Error("jobId must be a non-empty string");
    }

    const auditId = `audit-${randomUUID()}`;
    const challenge = randomBytes(32).toString("hex");
    const startedAt = this.#now().toISOString();

    const binding: AuditBinding = {
      auditId,
      jobId: input.jobId,
      evidenceSha256: input.evidenceSha256,
      packetSha256: input.packetSha256,
      collectManifest: input.collectManifest,
      startedAt,
    };

    this.#bindingsByAuditId.set(auditId, binding);
    this.#auditIdByChallenge.set(challenge, auditId);
    this.#challengeByAuditId.set(auditId, challenge);

    const prompt = buildAuditPrompt({
      challenge,
      jobId: input.jobId,
      evidenceSha256: input.evidenceSha256,
      packetSha256: input.packetSha256,
      evidencePacketText: input.evidencePacket,
    });

    const acknowledgement = await this.#browser.launchWebConversation(prompt, {
      attachDevSpace: true,
    });
    this.#conversationIdentityByAuditId.set(
      auditId,
      acknowledgement.conversationIdentitySha256,
    );

    return {
      auditId,
      challenge,
      status: "pending",
      startedAt,
    };
  }

  #stopConversationRecovery(auditId: string): void {
    const conversationIdentitySha256 =
      this.#conversationIdentityByAuditId.get(auditId);
    if (!conversationIdentitySha256) return;
    try {
      this.#browser.stopWebConversationRecovery?.(conversationIdentitySha256);
    } catch {
      // Retained audit state must not depend on watcher cleanup succeeding.
    }
  }

  submitAudit(input: AuditSubmitInput): {
    auditId: string;
    status: "succeeded";
    completedAt: string;
  } {
    const challenge = input.challenge.trim();
    if (!HEX_64_PATTERN.test(challenge)) {
      throw new Error("challenge must be a valid 64-character hex string");
    }

    const auditId = this.#auditIdByChallenge.get(challenge);
    if (!auditId) {
      throw new Error("challenge invalid, expired, or already used (replay rejected)");
    }

    const binding = this.#bindingsByAuditId.get(auditId);
    if (!binding) {
      throw new Error(`audit state missing for ${auditId}`);
    }

    // Cross-check model-passed parameters if supplied
    if (input.job_id && input.job_id !== binding.jobId) {
      throw new Error(`job_id mismatch: expected ${binding.jobId}, got ${input.job_id}`);
    }
    if (input.evidence_sha256 && input.evidence_sha256.toLowerCase() !== binding.evidenceSha256.toLowerCase()) {
      throw new Error(`evidence_sha256 mismatch: expected ${binding.evidenceSha256}, got ${input.evidence_sha256}`);
    }
    if (input.packet_sha256 && input.packet_sha256.toLowerCase() !== binding.packetSha256.toLowerCase()) {
      throw new Error(`packet_sha256 mismatch: expected ${binding.packetSha256}, got ${input.packet_sha256}`);
    }

    const validatedResult = auditResultSchema.parse(input.result);

    // Atomically consume challenge to prevent replay after validation passes
    this.#auditIdByChallenge.delete(challenge);
    this.#challengeByAuditId.delete(auditId);

    const completedAt = this.#now().toISOString();

    const retained: RetainedAudit = {
      audit_id: auditId,
      job_id: binding.jobId,
      status: "succeeded",
      execution_surface: this.#executionSurface,
      declared_model: "gpt-5.6-sol",
      api_mode: false,
      evidence_sha256: binding.evidenceSha256,
      packet_sha256: binding.packetSha256,
      collect_manifest: binding.collectManifest ?? null,
      result: validatedResult,
      started_at: binding.startedAt,
      completed_at: completedAt,
    };

    this.#retainedByAuditId.set(auditId, retained);
    this.#stopConversationRecovery(auditId);

    // If part of an active batch orchestrator, notify batch
    const batchId = this.#batchIdByAuditId.get(auditId);
    if (batchId) {
      this.#updateBatchProgress(batchId, auditId, retained);
    }

    return {
      auditId,
      status: "succeeded",
      completedAt,
    };
  }

  getAuditStatus(auditId: string): {
    auditId: string;
    status: "pending" | "succeeded";
    retained?: RetainedAudit;
    startedAt?: string;
  } {
    const retained = this.#retainedByAuditId.get(auditId);
    if (retained) {
      return {
        auditId,
        status: "succeeded",
        retained,
      };
    }

    const binding = this.#bindingsByAuditId.get(auditId);
    if (binding) {
      return {
        auditId,
        status: "pending",
        startedAt: binding.startedAt,
      };
    }

    throw new Error(`audit not found: ${auditId}`);
  }

  async startAuditBatch(
    jobs: BatchAuditJobInput[],
    options: { concurrency?: number } = {},
  ): Promise<RetainedAuditBatch> {
    if (jobs.length === 0) {
      throw new Error("jobs must contain at least one audit job");
    }

    const concurrency = Math.min(
      Math.max(options.concurrency ?? DEFAULT_AUDIT_CONCURRENCY, MIN_AUDIT_CONCURRENCY),
      MAX_AUDIT_CONCURRENCY,
    );

    const batchId = `audit-batch-${randomUUID()}`;
    const startedAt = this.#now().toISOString();

    const batch: RetainedAuditBatch = {
      batch_id: batchId,
      total_jobs: jobs.length,
      concurrency,
      status: "running",
      succeeded_jobs: 0,
      failed_jobs: 0,
      pending_jobs: jobs.length,
      jobs: jobs.map((j) => ({
        job_id: j.jobId,
        status: "pending",
        evidence_sha256: j.evidenceSha256,
        packet_sha256: j.packetSha256,
        collect_manifest: j.collectManifest,
      })),
      started_at: startedAt,
    };

    this.#batchesById.set(batchId, batch);
    this.#batchJobsById.set(batchId, jobs);

    // Launch initial pool of jobs up to concurrency limit
    await this.#pumpBatchQueue(batchId);

    return batch;
  }

  async #pumpBatchQueue(batchId: string): Promise<void> {
    const batch = this.#batchesById.get(batchId);
    if (!batch || batch.status !== "running") return;
    const jobs = this.#batchJobsById.get(batchId);
    if (!jobs) return;

    const runningCount = batch.jobs.filter((j) => j.status === "running").length;
    const availableSlots = batch.concurrency - runningCount;

    if (availableSlots <= 0) return;

    const pendingJobs = batch.jobs.filter((j) => j.status === "pending").slice(0, availableSlots);
    for (const pending of pendingJobs) {
      pending.status = "running";
      batch.pending_jobs -= 1;
    }

    await Promise.all(
      pendingJobs.map(async (pending) => {
        const jobInput = jobs.find((j) => j.jobId === pending.job_id);
        if (!jobInput) return;

        try {
          const startResult = await this.startAudit({
            jobId: jobInput.jobId,
            evidencePacket: jobInput.evidencePacket,
            evidenceSha256: jobInput.evidenceSha256,
            packetSha256: jobInput.packetSha256,
            collectManifest: jobInput.collectManifest,
          });

          pending.audit_id = startResult.auditId;
          pending.challenge = startResult.challenge;
          this.#batchIdByAuditId.set(startResult.auditId, batchId);
        } catch (err) {
          pending.status = "failed";
          pending.error = err instanceof Error ? err.message : String(err);
          batch.failed_jobs += 1;
          this.#checkBatchCompletion(batch);
          // Continue pumping next job on failure
          void this.#pumpBatchQueue(batchId);
        }
      }),
    );
  }

  #checkBatchCompletion(batch: RetainedAuditBatch): void {
    const terminalCount = batch.succeeded_jobs + batch.failed_jobs;
    if (terminalCount >= batch.total_jobs) {
      batch.status = batch.failed_jobs === 0 ? "succeeded" : "failed";
      batch.completed_at = this.#now().toISOString();

      // Deterministic aggregate hash over sorted jobs
      const sortedSummaries = [...batch.jobs]
        .sort((a, b) => a.job_id.localeCompare(b.job_id))
        .map((j) => ({
          job_id: j.job_id,
          audit_id: j.audit_id ?? null,
          status: j.status,
          evidence_sha256: j.evidence_sha256,
          packet_sha256: j.packet_sha256,
        }));
      batch.batch_aggregate_sha256 = sha256Json(sortedSummaries);
    }
  }

  #updateBatchProgress(batchId: string, auditId: string, retained: RetainedAudit): void {
    const batch = this.#batchesById.get(batchId);
    if (!batch) return;

    const targetJob = batch.jobs.find((j) => j.audit_id === auditId || j.job_id === retained.job_id);
    if (targetJob) {
      targetJob.status = "succeeded";
      targetJob.result = retained.result;
      delete targetJob.challenge;
      batch.succeeded_jobs += 1;
    }

    this.#checkBatchCompletion(batch);

    if (batch.status === "running") {
      void this.#pumpBatchQueue(batchId);
    }
  }

  recordBatchJobFailure(batchId: string, auditIdOrJobId: string, error: string): void {
    const batch = this.#batchesById.get(batchId);
    if (!batch) return;

    const targetJob = batch.jobs.find(
      (j) => j.audit_id === auditIdOrJobId || j.job_id === auditIdOrJobId,
    );
    if (targetJob && targetJob.status !== "succeeded" && targetJob.status !== "failed") {
      if (targetJob.status === "pending") {
        batch.pending_jobs -= 1;
      }
      targetJob.status = "failed";
      targetJob.error = error;
      batch.failed_jobs += 1;
      if (targetJob.audit_id) {
        this.#stopConversationRecovery(targetJob.audit_id);
      }
    }

    this.#checkBatchCompletion(batch);

    if (batch.status === "running") {
      void this.#pumpBatchQueue(batchId);
    }
  }

  getAuditBatchStatus(batchId: string): RetainedAuditBatch {
    const batch = this.#batchesById.get(batchId);
    if (!batch) {
      throw new Error(`audit batch not found: ${batchId}`);
    }
    return batch;
  }
}

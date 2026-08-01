import { randomBytes } from "node:crypto";
import type { WebLaunchBrowserController } from "./web-launch-browser.js";

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_RUN_RETENTION_MS = 10 * 60_000;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

export type ExternalConversationRunStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "expired";

export interface ExternalConversationRun<TResult> {
  id: string;
  status: ExternalConversationRunStatus;
  startedAt: string;
  expiresAt: string;
  launchIdentity?: string;
  callbackReceivedAt?: string;
  result?: TResult;
  failureCode?: string;
}

export interface WebConnectorProofResult extends Record<string, unknown> {
  connectorDiscovered: true;
  connectorInvoked: true;
  probeTool: "web_connector_probe";
  conversationIdentitySha256: string;
  invocationTimestamp: string;
  assistantOutputCaptured: false;
}

export interface WebConnectorStartAcknowledgement extends Record<string, unknown> {
  slice: "WEB-CONNECTOR-1";
  proofId: string;
  status: "pending";
  startedAt: string;
  expiresAt: string;
  assistantOutputCaptured: false;
}

export interface WebConnectorProbeAcknowledgement extends Record<string, unknown> {
  slice: "WEB-CONNECTOR-1";
  probeAccepted: true;
  timestamp: string;
}

interface WebConnectorStatusBase extends Record<string, unknown> {
  slice: "WEB-CONNECTOR-1";
  proofId: string;
  status: ExternalConversationRunStatus;
  startedAt: string;
  expiresAt: string;
  assistantOutputCaptured: false;
}

export interface WebConnectorPendingStatus extends WebConnectorStatusBase {
  status: "pending";
}

export interface WebConnectorSucceededStatus extends WebConnectorStatusBase,
  WebConnectorProofResult {
  status: "succeeded";
}

export interface WebConnectorFailedStatus extends WebConnectorStatusBase {
  status: "failed";
  failureCode: string;
}

export interface WebConnectorExpiredStatus extends WebConnectorStatusBase {
  status: "expired";
}

export type WebConnectorStatusAcknowledgement =
  | WebConnectorPendingStatus
  | WebConnectorSucceededStatus
  | WebConnectorFailedStatus
  | WebConnectorExpiredStatus;

export interface WebConnectorProofOptions {
  challengeFactory?: () => string;
  proofIdFactory?: () => string;
  now?: () => Date;
  timeoutMs?: number;
  retentionMs?: number;
}

interface RetainedRunRecord<TResult> {
  run: ExternalConversationRun<TResult>;
  expirationTimer: NodeJS.Timeout;
  cleanupTimer?: NodeJS.Timeout;
}

interface RetainedExternalConversationRunsOptions<TResult> {
  timeoutMs: number;
  retentionMs: number;
  buildResult(run: ExternalConversationRun<TResult>): TResult;
  onTerminal?(run: ExternalConversationRun<TResult>): void;
}

export class RetainedExternalConversationRuns<TResult> {
  readonly #timeoutMs: number;
  readonly #retentionMs: number;
  readonly #buildResult: (run: ExternalConversationRun<TResult>) => TResult;
  readonly #onTerminal?: (run: ExternalConversationRun<TResult>) => void;
  readonly #records = new Map<string, RetainedRunRecord<TResult>>();
  #activeRunId: string | undefined;

  constructor(options: RetainedExternalConversationRunsOptions<TResult>) {
    this.#timeoutMs = assertPositiveInteger(options.timeoutMs, "run timeout");
    this.#retentionMs = assertPositiveInteger(options.retentionMs, "run retention");
    this.#buildResult = options.buildResult;
    this.#onTerminal = options.onTerminal;
  }

  start(id: string, startedAt: Date): ExternalConversationRun<TResult> {
    if (this.#activeRunId) {
      throw new WebConnectorProofError(
        "WEB-CONNECTOR-1 already has a connector run in progress",
      );
    }
    if (this.#records.has(id)) {
      throw new WebConnectorProofError("WEB-CONNECTOR-1 generated a duplicate proof ID");
    }

    const startedAtIso = startedAt.toISOString();
    const expiresAt = new Date(startedAt.getTime() + this.#timeoutMs).toISOString();
    const run: ExternalConversationRun<TResult> = {
      id,
      status: "pending",
      startedAt: startedAtIso,
      expiresAt,
    };
    const expirationTimer = setTimeout(() => {
      const record = this.#records.get(id);
      if (!record || record.run.status !== "pending") return;
      record.run.status = "expired";
      this.#terminalize(record);
    }, this.#timeoutMs);
    expirationTimer.unref?.();

    this.#records.set(id, { run, expirationTimer });
    this.#activeRunId = id;
    return cloneRun(run);
  }

  get(id: string): ExternalConversationRun<TResult> | undefined {
    const record = this.#records.get(id);
    return record ? cloneRun(record.run) : undefined;
  }

  recordLaunchIdentity(id: string, launchIdentity: string): void {
    const record = this.#records.get(id);
    if (!record || record.run.status !== "pending") return;
    record.run.launchIdentity = launchIdentity;
    this.#completeIfReady(record);
  }

  recordCallback(id: string, callbackReceivedAt: string): void {
    const record = this.#records.get(id);
    if (!record || record.run.status !== "pending") {
      throw new WebConnectorProofError(
        "WEB-CONNECTOR-1 proof is unknown, expired, or already completed",
      );
    }
    record.run.callbackReceivedAt = callbackReceivedAt;
    this.#completeIfReady(record);
  }

  fail(id: string, failureCode: string): void {
    const record = this.#records.get(id);
    if (!record || record.run.status !== "pending") return;
    record.run.status = "failed";
    record.run.failureCode = failureCode;
    this.#terminalize(record);
  }

  close(): void {
    for (const record of this.#records.values()) {
      clearTimeout(record.expirationTimer);
      if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    }
    this.#records.clear();
    this.#activeRunId = undefined;
  }

  #completeIfReady(record: RetainedRunRecord<TResult>): void {
    if (!record.run.launchIdentity || !record.run.callbackReceivedAt) return;
    record.run.result = this.#buildResult(record.run);
    record.run.status = "succeeded";
    this.#terminalize(record);
  }

  #terminalize(record: RetainedRunRecord<TResult>): void {
    clearTimeout(record.expirationTimer);
    if (this.#activeRunId === record.run.id) this.#activeRunId = undefined;
    this.#onTerminal?.(cloneRun(record.run));

    record.cleanupTimer = setTimeout(() => {
      const current = this.#records.get(record.run.id);
      if (current === record) this.#records.delete(record.run.id);
    }, this.#retentionMs);
    record.cleanupTimer.unref?.();
  }
}

export class WebConnectorProofError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebConnectorProofError";
  }
}

export class WebConnectorProofController {
  readonly #browser: Pick<WebLaunchBrowserController, "launchWebConversation">;
  readonly #challengeFactory: () => string;
  readonly #proofIdFactory: () => string;
  readonly #now: () => Date;
  readonly #runs: RetainedExternalConversationRuns<WebConnectorProofResult>;
  readonly #proofIdByChallenge = new Map<string, string>();
  readonly #challengeByProofId = new Map<string, string>();

  constructor(
    browser: Pick<WebLaunchBrowserController, "launchWebConversation">,
    options: WebConnectorProofOptions = {},
  ) {
    this.#browser = browser;
    this.#challengeFactory =
      options.challengeFactory ?? (() => randomBytes(32).toString("hex"));
    this.#proofIdFactory =
      options.proofIdFactory ?? (() => randomBytes(32).toString("hex"));
    this.#now = options.now ?? (() => new Date());

    this.#runs = new RetainedExternalConversationRuns<WebConnectorProofResult>({
      timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      retentionMs: options.retentionMs ?? DEFAULT_RUN_RETENTION_MS,
      buildResult: (run) => ({
        connectorDiscovered: true,
        connectorInvoked: true,
        probeTool: "web_connector_probe",
        conversationIdentitySha256: run.launchIdentity as string,
        invocationTimestamp: run.callbackReceivedAt as string,
        assistantOutputCaptured: false,
      }),
      onTerminal: (run) => this.#removeChallengeForProof(run.id),
    });
  }

  startConnectorAccess(): WebConnectorStartAcknowledgement {
    const challenge = this.#challengeFactory();
    const proofId = this.#proofIdFactory();
    assertValidHex64(challenge, "challenge");
    assertValidHex64(proofId, "proof ID");

    if (this.#proofIdByChallenge.has(challenge)) {
      throw new WebConnectorProofError("WEB-CONNECTOR-1 generated a duplicate challenge");
    }
    if (this.#runs.get(proofId)) {
      throw new WebConnectorProofError("WEB-CONNECTOR-1 generated a duplicate proof ID");
    }

    const run = this.#runs.start(proofId, this.#now());
    this.#proofIdByChallenge.set(challenge, proofId);
    this.#challengeByProofId.set(proofId, challenge);

    void Promise.resolve()
      .then(() =>
        this.#browser.launchWebConversation(buildWebConnectorProbePrompt(challenge)),
      )
      .then(
        (launch) => {
          this.#runs.recordLaunchIdentity(
            proofId,
            launch.conversationIdentitySha256,
          );
        },
        () => {
          this.#runs.fail(proofId, "launch_failed");
        },
      );

    return {
      slice: "WEB-CONNECTOR-1",
      proofId,
      status: "pending",
      startedAt: run.startedAt,
      expiresAt: run.expiresAt,
      assistantOutputCaptured: false,
    };
  }

  acceptProbe(challenge: string): WebConnectorProbeAcknowledgement {
    assertValidHex64(challenge, "challenge");
    const proofId = this.#proofIdByChallenge.get(challenge);
    if (!proofId) {
      throw new WebConnectorProofError(
        "WEB-CONNECTOR-1 challenge is unknown, expired, or already consumed",
      );
    }

    this.#proofIdByChallenge.delete(challenge);
    this.#challengeByProofId.delete(proofId);
    const timestamp = this.#now().toISOString();
    this.#runs.recordCallback(proofId, timestamp);

    return {
      slice: "WEB-CONNECTOR-1",
      probeAccepted: true,
      timestamp,
    };
  }

  getProofStatus(proofId: string): WebConnectorStatusAcknowledgement {
    assertValidHex64(proofId, "proof ID");
    const run = this.#runs.get(proofId);
    if (!run) {
      throw new WebConnectorProofError(
        "WEB-CONNECTOR-1 proof is unknown or no longer retained",
      );
    }

    const base = {
      slice: "WEB-CONNECTOR-1" as const,
      proofId,
      status: run.status,
      startedAt: run.startedAt,
      expiresAt: run.expiresAt,
      assistantOutputCaptured: false as const,
    };

    switch (run.status) {
      case "pending":
        return { ...base, status: "pending" };
      case "succeeded":
        return {
          ...base,
          status: "succeeded",
          ...(run.result as WebConnectorProofResult),
        };
      case "failed":
        return {
          ...base,
          status: "failed",
          failureCode: run.failureCode ?? "unknown_failure",
        };
      case "expired":
        return { ...base, status: "expired" };
    }
  }

  close(): void {
    this.#proofIdByChallenge.clear();
    this.#challengeByProofId.clear();
    this.#runs.close();
  }

  #removeChallengeForProof(proofId: string): void {
    const challenge = this.#challengeByProofId.get(proofId);
    if (!challenge) return;
    this.#challengeByProofId.delete(proofId);
    this.#proofIdByChallenge.delete(challenge);
  }
}

export function buildWebConnectorProbePrompt(challenge: string): string {
  assertValidHex64(challenge, "challenge");
  return [
    "WEB-CONNECTOR-1 acceptance probe.",
    "Use the connected DevSpace connector through the normal ChatGPT tool interface.",
    "Invoke the bounded `web_connector_probe` tool exactly once with this exact challenge:",
    challenge,
    "Do not invoke any other connector tool.",
    "After the probe succeeds, stop. Do not ask the user a question.",
  ].join("\n");
}

function assertValidHex64(value: string, label: "challenge" | "proof ID"): void {
  if (!HEX_64_PATTERN.test(value)) {
    throw new WebConnectorProofError(
      `WEB-CONNECTOR-1 ${label} must be exactly 64 lowercase hexadecimal characters`,
    );
  }
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WebConnectorProofError(
      `WEB-CONNECTOR-1 ${label} must be a positive integer`,
    );
  }
  return value;
}

function cloneRun<TResult>(
  run: ExternalConversationRun<TResult>,
): ExternalConversationRun<TResult> {
  return { ...run };
}

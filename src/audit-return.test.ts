import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { AuditReturnController } from "./audit-return.js";
// @ts-expect-error untyped local mjs module
import { sealAuditResult } from "../scripts/chatshare-runner.mjs";
import { WorkspaceRegistry } from "./workspaces.js";

function testConfig(parent: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "audit-return-test-owner-token",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      scopes: ["devspace"],
      allowedRedirectHosts: ["localhost"],
      deviceAuthorization: {
        enabled: false,
        required: false,
        loopbackPort: 7677,
        extensionId: "aaoelopmdnhifffjefciagfmhjanbaoc",
        allowedRedirectPrefixes: [],
        challengeTtlSeconds: 60,
      },
    },
    allowedRoots: [parent],
    allowedHosts: ["127.0.0.1"],
    publicBaseUrl: "http://127.0.0.1:7676",
    minimalTools: false,
    toolNaming: "short",
    widgets: "off",
    chatSessionProvider: "chatgpt",
    stateDir: join(parent, "state"),
    skillsEnabled: false,
    skillPaths: [],
    agentDir: join(parent, "agents"),
    logging: {
      level: "silent",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
  };
}

test("AuditReturnController lifecycle, challenge replay prevention, and provenance retention", async () => {
  let launchedPrompt = "";
  let attachDevSpace: boolean | undefined;
  const stoppedRecovery: string[] = [];
  const mockBrowser = {
    launchWebConversation: async (prompt: string, options?: { attachDevSpace?: boolean }) => {
      launchedPrompt = prompt;
      attachDevSpace = options?.attachDevSpace;
      return {
        slice: "WEB-LAUNCH-0" as const,
        launchSuccess: true as const,
        conversationIdentitySha256: "dummy-conv-hash",
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false as const,
      };
    },
    stopWebConversationRecovery: (conversationIdentitySha256: string) => {
      stoppedRecovery.push(conversationIdentitySha256);
      return true;
    },
  };

  const controller = new AuditReturnController(mockBrowser);

  const evidenceSha256 = "3fa2c15dfd4975b0dde704aca1773ee566d507f0738c8452be323129c88082c1";
  const packetSha256 = "93985f45d2541a9dcfa83b52ad8b281c7e82542a812b92caafe4082098f85484";
  const jobId = "20260928-prospective-NVDA";

  // 1. Start audit
  const startResult = await controller.startAudit({
    jobId,
    evidencePacket: JSON.stringify({ task: "Audit NVDA", evidence: { text: "sample" } }),
    evidenceSha256,
    packetSha256,
    collectManifest: "manifests/bf6b8a64-d156-439b-b5a2-4719bcd4ba44.json",
  });

  assert.equal(startResult.status, "pending");
  assert.match(startResult.challenge, /^[0-9a-f]{64}$/i);
  assert.ok(launchedPrompt.includes("CRITICAL CONSTRAINTS:"));
  assert.ok(launchedPrompt.includes("Do NOT perform any web search"));
  assert.ok(launchedPrompt.includes(startResult.challenge));
  assert.equal(attachDevSpace, true);

  // 2. Query status before submit -> pending
  const pendingStatus = controller.getAuditStatus(startResult.auditId);
  assert.equal(pendingStatus.status, "pending");
  assert.equal(pendingStatus.retained, undefined);

  // 3. Submit with invalid challenge -> throws
  assert.throws(
    () =>
      controller.submitAudit({
        challenge: "0".repeat(64),
        result: {
          summary: "test",
          findings: [{ claim: "test", evidence_quote: "quote" }],
          uncertainties: [],
        },
      }),
    /challenge invalid, expired, or already used/,
  );

  // 4. Submit with valid challenge and matching metadata
  const submitResult = controller.submitAudit({
    challenge: startResult.challenge,
    job_id: jobId,
    evidence_sha256: evidenceSha256,
    packet_sha256: packetSha256,
    result: {
      summary: "Nvidia valuation warning sign with data center revenue growth",
      findings: [
        {
          claim: "Nvidia valuation faces compression warning sign",
          evidence_quote: "Nvidia’s stock is flashing a warning sign as valuation falls",
        },
      ],
      uncertainties: ["Forward margin sustainability under competitive custom ASICs"],
    },
  });

  assert.equal(submitResult.status, "succeeded");
  assert.equal(submitResult.auditId, startResult.auditId);
  assert.deepEqual(stoppedRecovery, ["dummy-conv-hash"]);

  // 5. Replay attempt with same challenge -> REJECTED
  assert.throws(
    () =>
      controller.submitAudit({
        challenge: startResult.challenge,
        result: {
          summary: "replay",
          findings: [{ claim: "replay", evidence_quote: "quote" }],
          uncertainties: [],
        },
      }),
    /challenge invalid, expired, or already used/,
  );

  // 6. Query status after submit -> succeeded with server-owned provenance
  const succeededStatus = controller.getAuditStatus(startResult.auditId);
  assert.equal(succeededStatus.status, "succeeded");
  assert.ok(succeededStatus.retained);
  assert.equal(succeededStatus.retained.audit_id, startResult.auditId);
  assert.equal(succeededStatus.retained.execution_surface, "chatgpt_web");
  assert.equal(succeededStatus.retained.declared_model, "gpt-5.6-sol");
  assert.equal(succeededStatus.retained.api_mode, false);
  assert.equal(succeededStatus.retained.evidence_sha256, evidenceSha256);
  assert.equal(succeededStatus.retained.packet_sha256, packetSha256);
  assert.equal(
    succeededStatus.retained.collect_manifest,
    "manifests/bf6b8a64-d156-439b-b5a2-4719bcd4ba44.json",
  );
  assert.equal(succeededStatus.retained.result.findings.length, 1);
});

test("AuditReturnController retains ChatShare provenance when configured", async () => {
  const mockBrowser = {
    launchWebConversation: async () => ({
      slice: "WEB-LAUNCH-0" as const,
      launchSuccess: true as const,
      conversationIdentitySha256: "chatshare-audit-conv-hash",
      timestamp: new Date().toISOString(),
      assistantOutputCaptured: false as const,
    }),
  };
  const controller = new AuditReturnController(mockBrowser, {
    executionSurface: "chatshare",
  });
  const started = await controller.startAudit({
    jobId: "chatshare-provenance",
    evidencePacket: "evidence",
    evidenceSha256: "a".repeat(64),
    packetSha256: "b".repeat(64),
  });
  controller.submitAudit({
    challenge: started.challenge,
    result: {
      summary: "summary",
      findings: [{ claim: "claim", evidence_quote: "quote" }],
      uncertainties: [],
    },
  });
  assert.equal(
    controller.getAuditStatus(started.auditId).retained?.execution_surface,
    "chatshare",
  );
});

test("AuditReturnController deletes ChatShare history only after successful submit and retries transient busy state", async () => {
  const conversationHash = "c".repeat(64);
  const deleteCalls: string[] = [];
  let deleteAttempt = 0;
  const controller = new AuditReturnController(
    {
      launchWebConversation: async () => ({
        slice: "WEB-LAUNCH-0" as const,
        launchSuccess: true as const,
        conversationIdentitySha256: conversationHash,
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false as const,
      }),
      deleteWebConversation: async (identity) => {
        deleteCalls.push(identity);
        deleteAttempt += 1;
        return deleteAttempt === 1 ? ("busy" as const) : ("deleted" as const);
      },
    },
    {
      executionSurface: "chatshare",
      cleanupSucceededConversations: true,
      cleanupDelayMs: 1,
      cleanupRetryMs: 5,
      cleanupWatchMs: 100,
    },
  );

  const started = await controller.startAudit({
    jobId: "chatshare-cleanup-single",
    evidencePacket: "evidence",
    evidenceSha256: "a".repeat(64),
    packetSha256: "b".repeat(64),
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(deleteCalls, []);

  controller.submitAudit({
    challenge: started.challenge,
    result: {
      summary: "summary",
      findings: [{ claim: "claim", evidence_quote: "quote" }],
      uncertainties: [],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(controller.getAuditStatus(started.auditId).status, "succeeded");
  assert.deepEqual(deleteCalls, [conversationHash, conversationHash]);
});

test("AuditReturnController deletes every succeeded ChatShare batch child conversation", async () => {
  const conversationHashes = ["d".repeat(64), "e".repeat(64)];
  const deleted: string[] = [];
  let launchIndex = 0;
  const controller = new AuditReturnController(
    {
      launchWebConversation: async () => {
        const conversationIdentitySha256 = conversationHashes[launchIndex++];
        assert.ok(conversationIdentitySha256);
        return {
          slice: "WEB-LAUNCH-0" as const,
          launchSuccess: true as const,
          conversationIdentitySha256,
          timestamp: new Date().toISOString(),
          assistantOutputCaptured: false as const,
        };
      },
      deleteWebConversation: async (identity) => {
        deleted.push(identity);
        return "deleted" as const;
      },
    },
    {
      executionSurface: "chatshare",
      cleanupSucceededConversations: true,
      cleanupDelayMs: 1,
      cleanupRetryMs: 5,
      cleanupWatchMs: 5_000,
    },
  );

  const batch = await controller.startAuditBatch(
    [
      {
        jobId: "batch-cleanup-a",
        evidencePacket: "evidence-a",
        evidenceSha256: "1".repeat(64),
        packetSha256: "2".repeat(64),
      },
      {
        jobId: "batch-cleanup-b",
        evidencePacket: "evidence-b",
        evidenceSha256: "3".repeat(64),
        packetSha256: "4".repeat(64),
      },
    ],
    { concurrency: 2 },
  );

  for (const job of batch.jobs) {
    assert.ok(job.challenge);
    controller.submitAudit({
      challenge: job.challenge,
      result: {
        summary: `summary ${job.job_id}`,
        findings: [{ claim: "claim", evidence_quote: "quote" }],
        uncertainties: [],
      },
    });
  }

  const cleanupDeadline = Date.now() + 2_000;
  while (deleted.length < 2 && Date.now() < cleanupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(controller.getAuditBatchStatus(batch.batch_id).status, "succeeded");
  assert.deepEqual([...deleted].sort(), [...conversationHashes].sort());
});

test("failed Audit batch child preserves ChatShare history for diagnosis", async () => {
  const conversationHash = "f".repeat(64);
  const deleted: string[] = [];
  const controller = new AuditReturnController(
    {
      launchWebConversation: async () => ({
        slice: "WEB-LAUNCH-0" as const,
        launchSuccess: true as const,
        conversationIdentitySha256: conversationHash,
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false as const,
      }),
      deleteWebConversation: async (identity) => {
        deleted.push(identity);
        return "deleted" as const;
      },
    },
    {
      executionSurface: "chatshare",
      cleanupSucceededConversations: true,
      cleanupDelayMs: 1,
      cleanupRetryMs: 5,
      cleanupWatchMs: 100,
    },
  );

  const batch = await controller.startAuditBatch(
    [
      {
        jobId: "batch-failure-preserve",
        evidencePacket: "evidence",
        evidenceSha256: "5".repeat(64),
        packetSha256: "6".repeat(64),
      },
    ],
    { concurrency: 1 },
  );
  const child = batch.jobs[0];
  assert.ok(child?.audit_id);
  controller.recordBatchJobFailure(
    batch.batch_id,
    child.audit_id,
    "synthetic audit failure",
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(controller.getAuditBatchStatus(batch.batch_id).status, "failed");
  assert.deepEqual(deleted, []);
});

test("audit state survives across MCP sessions and integrates with seal", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-audit-mcp-test-"));
  const config = testConfig(parent);

  let launchedPrompt = "";
  const mockBrowser = {
    launchWebConversation: async (prompt: string) => {
      launchedPrompt = prompt;
      return {
        slice: "WEB-LAUNCH-0" as const,
        launchSuccess: true as const,
        conversationIdentitySha256: "dummy-conv-hash",
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false as const,
      };
    },
  };

  const workspaces = new WorkspaceRegistry(config);
  const reviewCheckpoints = createReviewCheckpointManager();
  const auditReturnController = new AuditReturnController(mockBrowser);

  const serverA = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    mockBrowser,
    undefined,
    undefined,
    undefined,
    { auditReturnController },
  );
  const serverB = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    mockBrowser,
    undefined,
    undefined,
    undefined,
    { auditReturnController },
  );

  const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
  const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
  const clientA = new Client({ name: "audit-start-client", version: "1.0.0" });
  const clientB = new Client({ name: "audit-callback-client", version: "1.0.0" });

  try {
    await Promise.all([
      serverA.connect(serverTransportA),
      clientA.connect(clientTransportA),
      serverB.connect(serverTransportB),
      clientB.connect(clientTransportB),
    ]);

    const listed = await clientA.listTools();
    const toolNames = listed.tools.map((t) => t.name);
    assert.ok(toolNames.includes("audit_start"));
    assert.ok(toolNames.includes("audit_submit"));
    assert.ok(toolNames.includes("audit_status"));

    const evidenceSha256 = "3fa2c15dfd4975b0dde704aca1773ee566d507f0738c8452be323129c88082c1";
    const packetSha256 = "93985f45d2541a9dcfa83b52ad8b281c7e82542a812b92caafe4082098f85484";
    const jobId = "20260928-prospective-NVDA";

    const startResRaw = await clientA.callTool({
      name: "audit_start",
      arguments: {
        jobId,
        evidencePacket: JSON.stringify({ task: "Audit NVDA", evidence: { text: "NVDA text" } }),
        evidenceSha256,
        packetSha256,
      },
    });
    const startRes = startResRaw as unknown as {
      structuredContent: { auditId: string; challenge: string; status: string };
    };

    const { auditId, challenge } = startRes.structuredContent;
    assert.ok(auditId.startsWith("audit-"));
    assert.match(challenge, /^[0-9a-f]{64}$/i);

    const statusResRaw1 = await clientB.callTool({
      name: "audit_status",
      arguments: { auditId },
    });
    const statusRes1 = statusResRaw1 as unknown as { structuredContent: { status: string } };
    assert.equal(statusRes1.structuredContent.status, "pending");

    const auditOutput = {
      summary: "Nvidia fundamental valuation audit",
      findings: [
        {
          claim: "Nvidia is facing valuation multiple reset",
          evidence_quote: "flashing a warning sign as valuation falls",
        },
      ],
      uncertainties: [],
    };

    const submitResRaw = await clientB.callTool({
      name: "audit_submit",
      arguments: {
        challenge,
        job_id: jobId,
        evidence_sha256: evidenceSha256,
        packet_sha256: packetSha256,
        result: auditOutput,
      },
    });
    const submitRes = submitResRaw as unknown as {
      structuredContent: { auditId: string; status: string };
    };
    assert.equal(submitRes.structuredContent.status, "succeeded");

    const statusResRaw2 = await clientA.callTool({
      name: "audit_status",
      arguments: { auditId },
    });
    const statusRes2 = statusResRaw2 as unknown as {
      structuredContent: {
        status: string;
        retained: {
          job_id: string;
          evidence_sha256: string;
          packet_sha256: string;
          execution_surface: string;
          declared_model: string;
          api_mode: boolean;
          result: typeof auditOutput;
        };
      };
    };
    assert.equal(statusRes2.structuredContent.status, "succeeded");
    const retained = statusRes2.structuredContent.retained;
    assert.equal(retained.job_id, jobId);
    assert.equal(retained.evidence_sha256, evidenceSha256);
    assert.equal(retained.packet_sha256, packetSha256);

    const sealRoot = join(parent, "seal-custody");
    const sealResult = await sealAuditResult(
      {
        job_id: retained.job_id,
        evidence_sha256: retained.evidence_sha256,
        packet_sha256: retained.packet_sha256,
        provenance: {
          execution_surface: retained.execution_surface,
          declared_model: "gpt-5.6-sol",
          api_mode: false,
        },
        result: retained.result,
      },
      { root: sealRoot },
    );

    assert.equal(sealResult.artifact.outcome, "sealed");
    assert.equal(sealResult.artifact.hashes.evidence_sha256, evidenceSha256);
    assert.equal(sealResult.artifact.hashes.packet_sha256, packetSha256);
  } finally {
    await Promise.all([clientA.close(), clientB.close()]);
    await Promise.all([serverA.close(), serverB.close()]);
    await rm(parent, { recursive: true, force: true });
  }
});

test("AuditReturnController batch orchestration: bounded concurrency, failure isolation, queue pumping, and deterministic hash", async () => {
  const launchedPrompts: string[] = [];
  const mockBrowser = {
    launchWebConversation: async (prompt: string) => {
      launchedPrompts.push(prompt);
      return {
        slice: "WEB-LAUNCH-0" as const,
        launchSuccess: true as const,
        conversationIdentitySha256: "conv-hash",
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false as const,
      };
    },
  };

  const controller = new AuditReturnController(mockBrowser);

  const hexA = "a".repeat(64);
  const hexB = "b".repeat(64);

  const jobs = [
    { jobId: "JOB-A", evidencePacket: "{}", evidenceSha256: hexA, packetSha256: hexB },
    { jobId: "JOB-B", evidencePacket: "{}", evidenceSha256: hexA, packetSha256: hexB },
    { jobId: "JOB-C", evidencePacket: "{}", evidenceSha256: hexA, packetSha256: hexB },
    { jobId: "JOB-D", evidencePacket: "{}", evidenceSha256: hexA, packetSha256: hexB },
    { jobId: "JOB-E", evidencePacket: "{}", evidenceSha256: hexA, packetSha256: hexB },
  ];

  // 1. Start batch with concurrency = 2
  const batch = await controller.startAuditBatch(jobs, { concurrency: 2 });
  assert.equal(batch.total_jobs, 5);
  assert.equal(batch.concurrency, 2);
  assert.equal(batch.status, "running");

  // Check that exactly 2 are running initially
  let currentStatus = controller.getAuditBatchStatus(batch.batch_id);
  let runningJobs = currentStatus.jobs.filter((j) => j.status === "running");
  assert.equal(runningJobs.length, 2);
  assert.equal(currentStatus.pending_jobs, 3);

  // 2. Succeed JOB-A
  const jobA = currentStatus.jobs.find((j) => j.job_id === "JOB-A")!;
  assert.ok(jobA.challenge);
  assert.ok(jobA.audit_id);
  controller.submitAudit({
    challenge: jobA.challenge!,
    job_id: "JOB-A",
    evidence_sha256: hexA,
    packet_sha256: hexB,
    result: {
      summary: "JOB-A summary",
      findings: [{ claim: "Claim A", evidence_quote: "Quote A" }],
      uncertainties: [],
    },
  });
  await new Promise((r) => setImmediate(r));

  // Verify JOB-A succeeded and JOB-C was pumped to running
  currentStatus = controller.getAuditBatchStatus(batch.batch_id);
  assert.equal(currentStatus.succeeded_jobs, 1);
  const jobC = currentStatus.jobs.find((j) => j.job_id === "JOB-C")!;
  assert.equal(jobC.status, "running");
  assert.ok(jobC.challenge);

  // 3. Fail JOB-B: verify failure isolation (does not block queue)
  const jobB = currentStatus.jobs.find((j) => j.job_id === "JOB-B")!;
  controller.recordBatchJobFailure(batch.batch_id, jobB.audit_id!, "simulated network timeout");
  await new Promise((r) => setImmediate(r));

  currentStatus = controller.getAuditBatchStatus(batch.batch_id);
  assert.equal(currentStatus.failed_jobs, 1);
  const jobD = currentStatus.jobs.find((j) => j.job_id === "JOB-D")!;
  assert.equal(jobD.status, "running");
  assert.ok(jobD.challenge);

  // 4. Complete JOB-C, JOB-D, and JOB-E
  controller.submitAudit({
    challenge: jobC.challenge!,
    job_id: "JOB-C",
    evidence_sha256: hexA,
    packet_sha256: hexB,
    result: {
      summary: "JOB-C summary",
      findings: [{ claim: "Claim C", evidence_quote: "Quote C" }],
      uncertainties: [],
    },
  });
  await new Promise((r) => setImmediate(r));

  currentStatus = controller.getAuditBatchStatus(batch.batch_id);
  const jobE = currentStatus.jobs.find((j) => j.job_id === "JOB-E")!;
  assert.equal(jobE.status, "running");
  assert.ok(jobE.challenge);

  controller.submitAudit({
    challenge: jobD.challenge!,
    job_id: "JOB-D",
    evidence_sha256: hexA,
    packet_sha256: hexB,
    result: {
      summary: "JOB-D summary",
      findings: [{ claim: "Claim D", evidence_quote: "Quote D" }],
      uncertainties: [],
    },
  });

  controller.submitAudit({
    challenge: jobE.challenge!,
    job_id: "JOB-E",
    evidence_sha256: hexA,
    packet_sha256: hexB,
    result: {
      summary: "JOB-E summary",
      findings: [{ claim: "Claim E", evidence_quote: "Quote E" }],
      uncertainties: [],
    },
  });

  // 5. Terminal state verification
  currentStatus = controller.getAuditBatchStatus(batch.batch_id);
  assert.equal(currentStatus.status, "failed"); // 1 failed, 4 succeeded
  assert.equal(currentStatus.succeeded_jobs, 4);
  assert.equal(currentStatus.failed_jobs, 1);
  assert.equal(currentStatus.pending_jobs, 0);
  assert.ok(currentStatus.completed_at);
  assert.match(currentStatus.batch_aggregate_sha256!, /^[0-9a-f]{64}$/i);
});

test("MCP server exposes audit_batch_start and audit_batch_status with queue execution", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-audit-batch-mcp-test-"));
  const config = testConfig(parent);

  const mockBrowser = {
    launchWebConversation: async () => ({
      slice: "WEB-LAUNCH-0" as const,
      launchSuccess: true as const,
      conversationIdentitySha256: "batch-conv-hash",
      timestamp: new Date().toISOString(),
      assistantOutputCaptured: false as const,
    }),
  };

  const workspaces = new WorkspaceRegistry(config);
  const reviewCheckpoints = createReviewCheckpointManager();

  const server = createMcpServer(config, workspaces, reviewCheckpoints, mockBrowser);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "audit-batch-client", version: "1.0.0" });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const toolNames = listed.tools.map((t) => t.name);
    assert.ok(toolNames.includes("audit_batch_start"));
    assert.ok(toolNames.includes("audit_batch_status"));

    const hexA = "1".repeat(64);
    const hexB = "2".repeat(64);

    // 1. Call audit_batch_start
    const batchStartResRaw = await client.callTool({
      name: "audit_batch_start",
      arguments: {
        jobs: [
          {
            jobId: "20260928-batch-TEST1",
            evidencePacket: JSON.stringify({ task: "test1", evidence: { text: "text1" } }),
            evidenceSha256: hexA,
            packetSha256: hexB,
          },
          {
            jobId: "20260928-batch-TEST2",
            evidencePacket: JSON.stringify({ task: "test2", evidence: { text: "text2" } }),
            evidenceSha256: hexA,
            packetSha256: hexB,
          },
        ],
        concurrency: 2,
      },
    });

    const batchStartRes = (batchStartResRaw as unknown) as {
      structuredContent: {
        batch_id: string;
        total_jobs: number;
        status: string;
        jobs: Array<{ job_id: string; audit_id?: string; challenge?: string }>;
      };
    };

    const batchId = batchStartRes.structuredContent.batch_id;
    assert.ok(batchId.startsWith("audit-batch-"));
    assert.equal(batchStartRes.structuredContent.total_jobs, 2);

    // 2. Query audit_batch_status -> running
    const statusResRaw1 = await client.callTool({
      name: "audit_batch_status",
      arguments: { batchId },
    });
    const statusRes1 = (statusResRaw1 as unknown) as {
      structuredContent: {
        status: string;
        jobs: Array<{ job_id: string; audit_id?: string; challenge?: string }>;
      };
    };
    assert.equal(statusRes1.structuredContent.status, "running");

    // 3. Submit both jobs via audit_submit
    for (const job of statusRes1.structuredContent.jobs) {
      assert.ok(job.challenge);
      await client.callTool({
        name: "audit_submit",
        arguments: {
          challenge: job.challenge,
          job_id: job.job_id,
          evidence_sha256: hexA,
          packet_sha256: hexB,
          result: {
            summary: `Summary for ${job.job_id}`,
            findings: [{ claim: `Claim for ${job.job_id}`, evidence_quote: "quote" }],
            uncertainties: [],
          },
        },
      });
    }

    // 4. Query audit_batch_status -> succeeded
    const statusResRaw2 = await client.callTool({
      name: "audit_batch_status",
      arguments: { batchId },
    });
    const statusRes2 = (statusResRaw2 as unknown) as {
      structuredContent: {
        status: string;
        succeeded_jobs: number;
        failed_jobs: number;
        batch_aggregate_sha256: string;
      };
    };
    assert.equal(statusRes2.structuredContent.status, "succeeded");
    assert.equal(statusRes2.structuredContent.succeeded_jobs, 2);
    assert.equal(statusRes2.structuredContent.failed_jobs, 0);
    assert.match(statusRes2.structuredContent.batch_aggregate_sha256, /^[0-9a-f]{64}$/i);
  } finally {
    await client.close();
    await server.close();
    await rm(parent, { recursive: true, force: true });
  }
});

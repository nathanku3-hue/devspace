import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ServerConfig } from "./config.js";
import {
  buildWebConnectorProbePrompt,
  WebConnectorProofController,
  WebConnectorProofError,
} from "./web-connector-proof.js";
import type {
  WebLaunchAcknowledgement,
  WebLaunchBrowserController,
} from "./web-launch-browser.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { WorkspaceRegistry } from "./workspaces.js";

const CHALLENGE = "1".repeat(64);
const PROOF_ID = "2".repeat(64);
const CONVERSATION_HASH = "3".repeat(64);
const START_TIME = "2026-08-01T17:15:00.000Z";
const INVOCATION_TIME = "2026-08-01T17:15:05.000Z";

function launchAcknowledgement(): WebLaunchAcknowledgement {
  return {
    slice: "WEB-LAUNCH-0",
    launchSuccess: true,
    conversationIdentitySha256: CONVERSATION_HASH,
    timestamp: "2026-08-01T17:15:01.000Z",
    assistantOutputCaptured: false,
  };
}

function testConfig(parent: string, minimalTools = false): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "web-connector-test-owner-token",
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
    minimalTools,
    toolNaming: "short",
    widgets: "off",
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("WEB-CONNECTOR-1 prompt is fixed, bounded, and names only the callback", () => {
  assert.equal(
    buildWebConnectorProbePrompt(CHALLENGE),
    [
      "WEB-CONNECTOR-1 acceptance probe.",
      "Use the connected DevSpace connector through the normal ChatGPT tool interface.",
      "Invoke the bounded `web_connector_probe` tool exactly once with this exact challenge:",
      CHALLENGE,
      "Do not invoke any other connector tool.",
      "After the probe succeeds, stop. Do not ask the user a question.",
    ].join("\n"),
  );
});

test("start retains the run and returns before browser launch resolves", async () => {
  const launch = deferred<WebLaunchAcknowledgement>();
  const prompts: string[] = [];
  const browser = {
    launchWebConversation: async (prompt: string) => {
      prompts.push(prompt);
      return launch.promise;
    },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const proof = new WebConnectorProofController(browser, {
    challengeFactory: () => CHALLENGE,
    proofIdFactory: () => PROOF_ID,
    now: () => new Date(START_TIME),
    timeoutMs: 1_000,
    retentionMs: 1_000,
  });

  try {
    const started = proof.startConnectorAccess();
    assert.deepEqual(started, {
      slice: "WEB-CONNECTOR-1",
      proofId: PROOF_ID,
      status: "pending",
      startedAt: START_TIME,
      expiresAt: "2026-08-01T17:15:01.000Z",
      assistantOutputCaptured: false,
    });
    assert.equal(proof.getProofStatus(PROOF_ID).status, "pending");
    assert.equal(prompts.length, 0);
    await Promise.resolve();
    assert.equal(prompts.length, 1);
    assert.throws(() => proof.startConnectorAccess(), /in progress|duplicate challenge/);
    launch.resolve(launchAcknowledgement());
  } finally {
    proof.close();
  }
});

test("callback and launch acknowledgement may arrive in either order", async (t) => {
  await t.test("callback first", async () => {
    const launch = deferred<WebLaunchAcknowledgement>();
    const times = [new Date(START_TIME), new Date(INVOCATION_TIME)];
    const proof = new WebConnectorProofController(
      { launchWebConversation: async () => launch.promise },
      {
        challengeFactory: () => CHALLENGE,
        proofIdFactory: () => PROOF_ID,
        now: () => times.shift() ?? new Date(INVOCATION_TIME),
        timeoutMs: 1_000,
        retentionMs: 1_000,
      },
    );

    try {
      proof.startConnectorAccess();
      proof.acceptProbe(CHALLENGE);
      assert.equal(proof.getProofStatus(PROOF_ID).status, "pending");
      launch.resolve(launchAcknowledgement());
      await waitFor(() => proof.getProofStatus(PROOF_ID).status === "succeeded");
      assert.deepEqual(proof.getProofStatus(PROOF_ID), {
        slice: "WEB-CONNECTOR-1",
        proofId: PROOF_ID,
        status: "succeeded",
        startedAt: START_TIME,
        expiresAt: "2026-08-01T17:15:01.000Z",
        connectorDiscovered: true,
        connectorInvoked: true,
        probeTool: "web_connector_probe",
        conversationIdentitySha256: CONVERSATION_HASH,
        invocationTimestamp: INVOCATION_TIME,
        assistantOutputCaptured: false,
      });
    } finally {
      proof.close();
    }
  });

  await t.test("launch first", async () => {
    const times = [new Date(START_TIME), new Date(INVOCATION_TIME)];
    let launchReturned = false;
    const proof = new WebConnectorProofController(
      {
        launchWebConversation: async () => {
          launchReturned = true;
          return launchAcknowledgement();
        },
      },
      {
        challengeFactory: () => CHALLENGE,
        proofIdFactory: () => PROOF_ID,
        now: () => times.shift() ?? new Date(INVOCATION_TIME),
        timeoutMs: 1_000,
        retentionMs: 1_000,
      },
    );

    try {
      proof.startConnectorAccess();
      await waitFor(() => launchReturned);
      assert.equal(proof.getProofStatus(PROOF_ID).status, "pending");
      proof.acceptProbe(CHALLENGE);
      await waitFor(() => proof.getProofStatus(PROOF_ID).status === "succeeded");
      assert.throws(() => proof.acceptProbe(CHALLENGE), /already consumed/);
    } finally {
      proof.close();
    }
  });
});

test("launch failure and expiry remain retrievable until cleanup", async (t) => {
  await t.test("launch failure", async () => {
    const proof = new WebConnectorProofController(
      { launchWebConversation: async () => Promise.reject(new Error("browser failed")) },
      {
        challengeFactory: () => CHALLENGE,
        proofIdFactory: () => PROOF_ID,
        now: () => new Date(START_TIME),
        timeoutMs: 1_000,
        retentionMs: 1_000,
      },
    );

    try {
      proof.startConnectorAccess();
      await waitFor(() => proof.getProofStatus(PROOF_ID).status === "failed");
      assert.equal(
        (proof.getProofStatus(PROOF_ID) as { failureCode?: string }).failureCode,
        "launch_failed",
      );
      assert.throws(() => proof.acceptProbe(CHALLENGE), /unknown, expired/);
    } finally {
      proof.close();
    }
  });

  await t.test("expiry and retained cleanup", async () => {
    const never = deferred<WebLaunchAcknowledgement>();
    const proof = new WebConnectorProofController(
      { launchWebConversation: async () => never.promise },
      {
        challengeFactory: () => CHALLENGE,
        proofIdFactory: () => PROOF_ID,
        now: () => new Date(START_TIME),
        timeoutMs: 20,
        retentionMs: 30,
      },
    );

    try {
      proof.startConnectorAccess();
      await waitFor(() => proof.getProofStatus(PROOF_ID).status === "expired");
      assert.throws(() => proof.acceptProbe(CHALLENGE), /unknown, expired/);
      await waitFor(() => {
        try {
          proof.getProofStatus(PROOF_ID);
          return false;
        } catch (error) {
          return error instanceof WebConnectorProofError && /no longer retained/.test(error.message);
        }
      });
    } finally {
      proof.close();
    }
  });
});

test("independent sessions survive source disconnect and retrieve the callback", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-connector-tool-"));
  const config = testConfig(parent, true);
  let releasePrompt: ((prompt: string) => void) | undefined;
  const promptReady = new Promise<string>((resolve) => {
    releasePrompt = resolve;
  });
  const browser = {
    launchWebConversation: async (prompt: string) => {
      releasePrompt?.(prompt);
      return launchAcknowledgement();
    },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const times = [new Date(START_TIME), new Date(INVOCATION_TIME)];
  const proof = new WebConnectorProofController(browser, {
    challengeFactory: () => CHALLENGE,
    proofIdFactory: () => PROOF_ID,
    now: () => times.shift() ?? new Date(INVOCATION_TIME),
    timeoutMs: 1_000,
    retentionMs: 1_000,
  });
  const workspaces = new WorkspaceRegistry(config);
  const reviewCheckpoints = createReviewCheckpointManager();
  const reviewReturn = {
    startReview: () => {
      throw new Error("unexpected review_start");
    },
    submitReview: () => {
      throw new Error("unexpected review_submit");
    },
    getReviewStatus: () => {
      throw new Error("unexpected review_status");
    },
  };
  const sourceServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    proof,
    reviewReturn,
  );
  const spawnedServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    proof,
    reviewReturn,
  );
  const statusServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    proof,
    reviewReturn,
  );
  const sourceClient = new Client({ name: "web-connector-source", version: "1.0.0" });
  const spawnedClient = new Client({ name: "web-connector-spawned", version: "1.0.0" });
  const statusClient = new Client({ name: "web-connector-status", version: "1.0.0" });
  const [sourceClientTransport, sourceServerTransport] = InMemoryTransport.createLinkedPair();
  const [spawnedClientTransport, spawnedServerTransport] = InMemoryTransport.createLinkedPair();
  const [statusClientTransport, statusServerTransport] = InMemoryTransport.createLinkedPair();

  try {
    await sourceServer.connect(sourceServerTransport);
    await spawnedServer.connect(spawnedServerTransport);
    await statusServer.connect(statusServerTransport);
    await sourceClient.connect(sourceClientTransport);
    await spawnedClient.connect(spawnedClientTransport);
    await statusClient.connect(statusClientTransport);

    const listed = await spawnedClient.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "bash",
        "cancel_long_task",
        "close_workspace",
        "edit",
        "long_task_status",
        "open_workspace",
        "publish_git_changes",
        "read",
        "read_files",
        "review_start",
        "review_status",
        "review_submit",
        "safe_rename_file",
        "start_long_task",
        "validate_task",
        "web_connector_probe",
        "web_connector_start",
        "web_connector_status",
        "web_launch",
        "write",
      ],
    );
    const start = listed.tools.find((tool) => tool.name === "web_connector_start");
    const probe = listed.tools.find((tool) => tool.name === "web_connector_probe");
    const status = listed.tools.find((tool) => tool.name === "web_connector_status");
    assert.ok(start);
    assert.ok(probe);
    assert.ok(status);
    assert.deepEqual(Object.keys(start.inputSchema.properties ?? {}), []);
    assert.deepEqual(Object.keys(probe.inputSchema.properties ?? {}), ["challenge"]);
    assert.deepEqual(Object.keys(status.inputSchema.properties ?? {}), ["proofId"]);
    assert.equal(probe.annotations?.readOnlyHint, false);
    assert.equal(probe.annotations?.idempotentHint, false);
    assert.equal(status.annotations?.readOnlyHint, true);
    assert.equal(status.annotations?.idempotentHint, true);

    const startResult = await sourceClient.callTool({
      name: "web_connector_start",
      arguments: {},
    });
    assert.deepEqual(startResult.structuredContent, {
      slice: "WEB-CONNECTOR-1",
      proofId: PROOF_ID,
      status: "pending",
      startedAt: START_TIME,
      expiresAt: "2026-08-01T17:15:01.000Z",
      assistantOutputCaptured: false,
    });
    const prompt = await promptReady;
    assert.match(prompt, new RegExp(CHALLENGE));

    await sourceClient.close();
    await sourceServer.close();

    const probeResult = await spawnedClient.callTool({
      name: "web_connector_probe",
      arguments: { challenge: CHALLENGE },
    });
    assert.deepEqual(probeResult.structuredContent, {
      slice: "WEB-CONNECTOR-1",
      probeAccepted: true,
      timestamp: INVOCATION_TIME,
    });

    const statusResult = await statusClient.callTool({
      name: "web_connector_status",
      arguments: { proofId: PROOF_ID },
    });
    assert.deepEqual(statusResult.structuredContent, {
      slice: "WEB-CONNECTOR-1",
      proofId: PROOF_ID,
      status: "succeeded",
      startedAt: START_TIME,
      expiresAt: "2026-08-01T17:15:01.000Z",
      connectorDiscovered: true,
      connectorInvoked: true,
      probeTool: "web_connector_probe",
      conversationIdentitySha256: CONVERSATION_HASH,
      invocationTimestamp: INVOCATION_TIME,
      assistantOutputCaptured: false,
    });
  } finally {
    proof.close();
    await sourceClient.close().catch(() => undefined);
    await spawnedClient.close().catch(() => undefined);
    await statusClient.close().catch(() => undefined);
    await sourceServer.close().catch(() => undefined);
    await spawnedServer.close().catch(() => undefined);
    await statusServer.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

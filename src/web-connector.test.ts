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
const CONVERSATION_HASH = "2".repeat(64);
const INVOCATION_TIME = "2026-08-01T09:15:00.000Z";

function launchAcknowledgement(): WebLaunchAcknowledgement {
  return {
    slice: "WEB-LAUNCH-0",
    launchSuccess: true,
    conversationIdentitySha256: CONVERSATION_HASH,
    timestamp: "2026-08-01T09:14:59.000Z",
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

test("WEB-CONNECTOR-1 prompt is fixed, bounded, and names only the read-only probe", () => {
  assert.equal(
    buildWebConnectorProbePrompt(CHALLENGE),
    [
      "WEB-CONNECTOR-1 acceptance probe.",
      "Use the connected DevSpace connector through the normal ChatGPT tool interface.",
      "Invoke the read-only `web_connector_probe` tool exactly once with this exact challenge:",
      CHALLENGE,
      "Do not invoke any other connector tool.",
      "After the probe succeeds, stop. Do not ask the user a question.",
    ].join("\n"),
  );
});

test("WEB-CONNECTOR-1 resolves only after the spawned conversation consumes its challenge", async () => {
  const prompts: string[] = [];
  let proof: WebConnectorProofController;
  const browser = {
    launchWebConversation: async (prompt: string) => {
      prompts.push(prompt);
      queueMicrotask(() => proof.acceptProbe(CHALLENGE));
      return launchAcknowledgement();
    },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  proof = new WebConnectorProofController(browser, {
    challengeFactory: () => CHALLENGE,
    now: () => new Date(INVOCATION_TIME),
    timeoutMs: 1_000,
  });

  const acknowledgement = await proof.proveConnectorAccess();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", new RegExp(CHALLENGE));
  assert.deepEqual(acknowledgement, {
    slice: "WEB-CONNECTOR-1",
    connectorDiscovered: true,
    connectorInvoked: true,
    probeTool: "web_connector_probe",
    conversationIdentitySha256: CONVERSATION_HASH,
    invocationTimestamp: INVOCATION_TIME,
    assistantOutputCaptured: false,
  });
  assert.throws(() => proof.acceptProbe(CHALLENGE), /already consumed/);
});

test("WEB-CONNECTOR-1 fails closed when no connector invocation arrives", async () => {
  const browser = {
    launchWebConversation: async () => launchAcknowledgement(),
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const proof = new WebConnectorProofController(browser, {
    challengeFactory: () => CHALLENGE,
    timeoutMs: 20,
  });

  await assert.rejects(
    proof.proveConnectorAccess(),
    (error: unknown) =>
      error instanceof WebConnectorProofError && /timed out/.test(error.message),
  );
  assert.throws(() => proof.acceptProbe(CHALLENGE), /unknown, expired/);
});

test("independent MCP sessions complete one bounded proof through the read-only probe", async () => {
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
  const proof = new WebConnectorProofController(browser, {
    challengeFactory: () => CHALLENGE,
    now: () => new Date(INVOCATION_TIME),
    timeoutMs: 1_000,
  });
  const workspaces = new WorkspaceRegistry(config);
  const reviewCheckpoints = createReviewCheckpointManager();
  const sourceServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    proof,
  );
  const spawnedServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    proof,
  );
  const sourceClient = new Client({ name: "web-connector-source", version: "1.0.0" });
  const spawnedClient = new Client({ name: "web-connector-spawned", version: "1.0.0" });
  const [sourceClientTransport, sourceServerTransport] =
    InMemoryTransport.createLinkedPair();
  const [spawnedClientTransport, spawnedServerTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await sourceServer.connect(sourceServerTransport);
    await spawnedServer.connect(spawnedServerTransport);
    await sourceClient.connect(sourceClientTransport);
    await spawnedClient.connect(spawnedClientTransport);

    const listed = await spawnedClient.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "bash",
        "close_workspace",
        "edit",
        "open_workspace",
        "publish_git_changes",
        "read",
        "read_files",
        "safe_rename_file",
        "web_connector_probe",
        "web_connector_proof",
        "web_launch",
        "write",
      ],
    );
    const trigger = listed.tools.find((tool) => tool.name === "web_connector_proof");
    const probe = listed.tools.find((tool) => tool.name === "web_connector_probe");
    assert.ok(trigger);
    assert.ok(probe);
    assert.deepEqual(Object.keys(trigger.inputSchema.properties ?? {}), []);
    assert.deepEqual(Object.keys(probe.inputSchema.properties ?? {}), ["challenge"]);
    assert.equal(probe.annotations?.readOnlyHint, true);

    const proofResult = sourceClient.callTool({
      name: "web_connector_proof",
      arguments: {},
    });
    const prompt = await promptReady;
    assert.match(prompt, new RegExp(CHALLENGE));

    const probeResult = await spawnedClient.callTool({
      name: "web_connector_probe",
      arguments: { challenge: CHALLENGE },
    });
    assert.deepEqual(probeResult.structuredContent, {
      slice: "WEB-CONNECTOR-1",
      probeAccepted: true,
      timestamp: INVOCATION_TIME,
    });
    assert.deepEqual((await proofResult).structuredContent, {
      slice: "WEB-CONNECTOR-1",
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
    await sourceServer.close().catch(() => undefined);
    await spawnedServer.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

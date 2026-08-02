import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ReviewReturnController } from "./review-return.js";
import { createMcpServer } from "./server.js";
import { WebConnectorProofController } from "./web-connector-proof.js";
import type {
  WebLaunchAcknowledgement,
  WebLaunchBrowserController,
} from "./web-launch-browser.js";
import { WorkspaceRegistry } from "./workspaces.js";

function testConfig(parent: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "web-launch-test-owner-token",
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

test("public web_launch exposes only WEB-LAUNCH-0 and preserves the supplied prompt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-tool-"));
  const config = testConfig(parent);
  const prompts: string[] = [];
  const acknowledgement: WebLaunchAcknowledgement = {
    slice: "WEB-LAUNCH-0",
    launchSuccess: true,
    conversationIdentitySha256: "a".repeat(64),
    timestamp: "2026-07-31T15:00:00.000Z",
    assistantOutputCaptured: false,
  };
  const browser = {
    launchWebConversation: async (prompt: string) => {
      prompts.push(prompt);
      return acknowledgement;
    },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config),
    createReviewCheckpointManager(),
    browser,
    new WebConnectorProofController(browser),
    new ReviewReturnController(browser),
  );
  const client = new Client({ name: "web-launch-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "web_launch");
    assert.ok(tool);
    assert.match(tool.description ?? "", /explicitly requests/i);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ["prompt"]);

    const prompt = "Keep  exact spacing.\nDo not continue.";
    const result = await client.callTool({ name: "web_launch", arguments: { prompt } });
    assert.deepEqual(prompts, [prompt]);
    assert.deepEqual(result.structuredContent, acknowledgement);
    assert.equal("assistantOutput" in (result.structuredContent ?? {}), false);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

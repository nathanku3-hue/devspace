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
import { WebConnectorProofController } from "./web-connector-proof.js";
import type { WebLaunchBrowserController } from "./web-launch-browser.js";
import { WorkspaceRegistry } from "./workspaces.js";

function testConfig(parent: string, minimalTools: boolean): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "shell-policy-test-owner-token",
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

for (const minimalTools of [true, false]) {
  test(`bash permits only bounded repository-local operational state in ${minimalTools ? "minimal" : "full"} tool mode`, async () => {
    const parent = await mkdtemp(join(tmpdir(), "devspace-shell-policy-test-"));
    const config = testConfig(parent, minimalTools);
    const browser = {
      launchWebConversation: async () => {
        throw new Error("web_launch is not used by this test");
      },
    } as Pick<WebLaunchBrowserController, "launchWebConversation">;
    const server = createMcpServer(
      config,
      new WorkspaceRegistry(config),
      createReviewCheckpointManager(),
      browser,
      new WebConnectorProofController(browser),
    );
    const client = new Client({ name: "shell-policy-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const instructions = client.getInstructions() ?? "";
      assert.match(instructions, /repository-local operational state/i);
      assert.match(instructions, /create-only or atomic filesystem semantics/i);
      assert.match(instructions, /inside the opened workspace/i);
      assert.match(instructions, /machine-global locations/i);
      assert.doesNotMatch(instructions, /do not use bash to create or modify files/i);

      const listed = await client.listTools();
      const tool = listed.tools.find((candidate) => candidate.name === "bash");
      assert.ok(tool);

      const description = tool.description ?? "";
      assert.match(description, /repository-local operational state/i);
      assert.match(description, /create-only or atomic filesystem semantics/i);
      assert.match(description, /inside the opened workspace/i);
      assert.match(description, /machine-global locations/i);

      const commandSchema = tool.inputSchema.properties?.command as
        | { description?: string }
        | undefined;
      const commandDescription = commandSchema?.description ?? "";
      assert.match(commandDescription, /repository-local operational state/i);
      assert.match(commandDescription, /outside the opened workspace/i);
      assert.match(commandDescription, /create-only or atomic filesystem semantics/i);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import {
  createServer,
  resolveMcpTransportMode,
  type McpTransportMode,
} from "./server.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function seedAccessToken(stateDir: string, token: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = store.registerClient(
      {
        redirect_uris: ["https://chatgpt.com/connector/oauth/devspace-session-test"],
        client_name: "DevSpace session test",
      },
      ["chatgpt.com", "chatshare.xyz", "localhost", "127.0.0.1"],
    );
    store.saveAccessToken(hashToken(token), {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      deviceBound: false,
    });
  } finally {
    store.close();
  }
}

async function withServer(
  mode: McpTransportMode,
  run: (origin: string, accessToken: string) => Promise<void>,
  options?: { maxMcpSessions?: number; mcpSessionIdleMs?: number },
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-mcp-session-test-"));
  const accessToken = "devspace-session-test-access-token";
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: stateDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_ALLOWED_HOSTS: "127.0.0.1,localhost,devspace.example.test",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.test",
    DEVSPACE_DEVICE_AUTH: "0",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
    HOST: "127.0.0.1",
  });
  seedAccessToken(stateDir, accessToken);

  const { app, close } = createServer(config, {
    mcpTransportMode: mode,
    maxMcpSessions: options?.maxMcpSessions,
    mcpSessionIdleMs: options?.mcpSessionIdleMs,
  });
  const httpServer = app.listen(0, "127.0.0.1");

  try {
    await once(httpServer, "listening");
    const { port } = httpServer.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`, accessToken);
  } finally {
    httpServer.close();
    await close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

function newClient(origin: string, accessToken: string, suffix: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
  const client = new Client({
    name: `devspace-session-test-${suffix}`,
    version: "1.0.0",
  });
  return { client, transport };
}

assert.equal(resolveMcpTransportMode(undefined), "stateless");
assert.equal(resolveMcpTransportMode(""), "stateless");
assert.equal(resolveMcpTransportMode("STATELESS"), "stateless");
assert.equal(resolveMcpTransportMode("stateful"), "stateful");
assert.throws(
  () => resolveMcpTransportMode("legacy"),
  /Invalid DEVSPACE_MCP_TRANSPORT_MODE/,
);

await withServer(
  "stateless",
  async (origin, accessToken) => {
    for (let index = 0; index < 4; index += 1) {
      const { client, transport } = newClient(origin, accessToken, `stateless-${index}`);
      try {
        await client.connect(transport);
        assert.equal(transport.sessionId, undefined);
        if (index === 3) {
          const listed = await client.listTools();
          assert.ok(listed.tools.some((tool) => tool.name === "open_workspace"));
        }
      } finally {
        await client.close().catch(() => undefined);
      }
    }
  },
  {
    maxMcpSessions: 2,
  },
);

await withServer(
  "stateful",
  async (origin, accessToken) => {
    const first = newClient(origin, accessToken, "stateful-first");
    const second = newClient(origin, accessToken, "stateful-second");
    const third = newClient(origin, accessToken, "stateful-third");

    try {
      await first.client.connect(first.transport);
      await second.client.connect(second.transport);
      assert.ok(first.transport.sessionId);
      assert.ok(second.transport.sessionId);

      await assert.rejects(
        third.client.connect(third.transport),
        /503|session limit|Failed to POST|Service Unavailable/i,
      );

      const firstTools = await first.client.listTools();
      const secondTools = await second.client.listTools();
      assert.ok(firstTools.tools.some((tool) => tool.name === "open_workspace"));
      assert.ok(secondTools.tools.some((tool) => tool.name === "open_workspace"));
    } finally {
      await Promise.allSettled([
        first.client.close(),
        second.client.close(),
        third.client.close(),
      ]);
    }
  },
  {
    maxMcpSessions: 2,
    mcpSessionIdleMs: 60_000,
  },
);

console.log("mcp transport mode tests passed");

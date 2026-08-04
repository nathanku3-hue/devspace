import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { databasePath, openDatabase } from "./db/client.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-test-"));
const oauthConfig = {
  ownerToken: "test-owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["chatgpt.com"],
  deviceAuthorization: {
    enabled: false,
    required: false,
    loopbackPort: 7677,
    extensionId: "aaoelopmdnhifffjefciagfmhjanbaoc",
    allowedRedirectPrefixes: ["https://chatshare.xyz/connector/oauth/"],
    challengeTtlSeconds: 60,
  },
};
const mcpUrl = new URL("https://agent.example.com/mcp");
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

try {
  await testDatabaseConfiguration(join(root, "database-configuration"));
  testNativeTaskMigrationPreservesExistingState(join(root, "native-task-migration"));
  testRedirectHostPolicy(join(root, "redirect-host-policy"));
  await testAuthorizationResourceCompatibility(join(root, "authorization-resource"));
  await testDeviceBoundAuthorization(join(root, "device-bound-authorization"));
  testPersistenceAndTokenHashing(join(root, "persistence"));
  testExpiredTokenCleanup(join(root, "expiration"));
  testTransactionalTokenRotation(join(root, "rotation"));
  await testProviderRestartRotationAndRevocation(join(root, "provider"));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testDatabaseConfiguration(stateDir: string): Promise<void> {
  const database = openDatabase(stateDir);
  try {
    assert.equal(database.sqlite.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.sqlite.pragma("synchronous", { simple: true }), 1);
    assert.equal(database.sqlite.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(database.sqlite.pragma("foreign_keys", { simple: true }), 1);

    const migrations = database.sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all();
    assert.deepEqual(migrations, [
      { version: 1, name: "workspace-state" },
      { version: 2, name: "oauth-state" },
      { version: 3, name: "oauth-device-bound-tokens" },
      { version: 4, name: "workspace-branch-metadata" },
      { version: 5, name: "workspace-head-metadata" },
      { version: 6, name: "native-task-continuation" },
    ]);
  } finally {
    database.close();
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(databasePath(stateDir))).mode & 0o777, 0o600);
  }
}

function testNativeTaskMigrationPreservesExistingState(stateDir: string): void {
  const database = openDatabase(stateDir);
  database.sqlite.prepare(`
    insert into workspace_sessions (
      id, root, status, mode, managed, created_at, last_used_at
    ) values (?, ?, 'active', 'checkout', 'false', ?, ?)
  `).run("ws_existing", stateDir, "2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
  database.sqlite.prepare(
    "insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)",
  ).run("existing-client", JSON.stringify({ redirect_uris: ["https://chatgpt.com/callback"] }), 1);
  database.sqlite.exec("drop table native_tasks");
  database.sqlite.prepare("delete from devspace_schema_migrations where version = 6").run();
  database.close();

  const migrated = openDatabase(stateDir);
  try {
    const workspaceRow = migrated.sqlite
      .prepare("select root from workspace_sessions where id = ?")
      .get("ws_existing") as { root: string } | undefined;
    const clientRow = migrated.sqlite
      .prepare("select client_id from oauth_clients where client_id = ?")
      .get("existing-client") as { client_id: string } | undefined;
    const migrationRow = migrated.sqlite
      .prepare("select name from devspace_schema_migrations where version = 6")
      .get() as { name: string } | undefined;
    const taskCount = migrated.sqlite
      .prepare("select count(*) as count from native_tasks")
      .get() as { count: number };
    assert.equal(workspaceRow?.root, stateDir);
    assert.equal(clientRow?.client_id, "existing-client");
    assert.equal(migrationRow?.name, "native-task-continuation");
    assert.equal(taskCount.count, 0);
  } finally {
    migrated.close();
  }
}

function testRedirectHostPolicy(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const clients = new SqliteOAuthClientsStore(
    store,
    ["perplexity.ai", "*.perplexity.ai", "chatgpt.com", "chatshare.xyz"],
    [
      {
        registeredBase: "https://chatgpt.com/connector/oauth/",
        requestedBase: "https://chatshare.xyz/connector/oauth/",
      },
    ],
  );

  try {
    const rootClient = clients.registerClient({
      redirect_uris: ["https://perplexity.ai/oauth/callback"],
    });
    assert.equal(rootClient.redirect_uris[0], "https://perplexity.ai/oauth/callback");

    const subdomainClient = clients.registerClient({
      redirect_uris: ["https://mcp.perplexity.ai/oauth/callback"],
    });
    assert.equal(subdomainClient.redirect_uris[0], "https://mcp.perplexity.ai/oauth/callback");

    const chatshareClient = clients.registerClient({
      redirect_uris: ["https://chatgpt.com/connector/oauth/TeAhvdjRY7qD?tenant=one"],
    });
    assert.deepEqual(chatshareClient.redirect_uris, [
      "https://chatgpt.com/connector/oauth/TeAhvdjRY7qD?tenant=one",
    ]);
    assert.deepEqual(clients.getClient(chatshareClient.client_id)?.redirect_uris, [
      "https://chatgpt.com/connector/oauth/TeAhvdjRY7qD?tenant=one",
      "https://chatshare.xyz/connector/oauth/TeAhvdjRY7qD?tenant=one",
    ]);

    const unrelatedPathClient = clients.registerClient({
      redirect_uris: ["https://chatgpt.com/connector/oauth-evil/TeAhvdjRY7qD"],
    });
    assert.deepEqual(clients.getClient(unrelatedPathClient.client_id)?.redirect_uris, [
      "https://chatgpt.com/connector/oauth-evil/TeAhvdjRY7qD",
    ]);

    const reverseClient = clients.registerClient({
      redirect_uris: ["https://chatshare.xyz/connector/oauth/TeAhvdjRY7qD"],
    });
    assert.deepEqual(clients.getClient(reverseClient.client_id)?.redirect_uris, [
      "https://chatshare.xyz/connector/oauth/TeAhvdjRY7qD",
    ]);

    for (const [redirectUri, rejectedIdentity] of [
      ["https://evilperplexity.ai/oauth/callback", "evilperplexity.ai"],
      ["https://perplexity.ai.evil.example/oauth/callback", "perplexity.ai.evil.example"],
      ["perplexity://oauth/callback", "perplexity:"],
    ]) {
      assert.throws(
        () => clients.registerClient({ redirect_uris: [redirectUri] }),
        new RegExp(
          `Client redirect_uri is not allowed for this DevSpace server: ${rejectedIdentity.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          )}`,
        ),
      );
    }
  } finally {
    store.close();
  }
}

async function testAuthorizationResourceCompatibility(stateDir: string): Promise<void> {
  const provider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await provider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "Perplexity",
  });
  assert.ok(client);

  let statusCode = 0;
  let responseBody = "";
  const response = {
    req: { method: "GET" },
    status(code: number) {
      statusCode = code;
      return this;
    },
    setHeader() {
      return this;
    },
    send(body: unknown) {
      responseBody = String(body);
      return this;
    },
  } as unknown as Parameters<SingleUserOAuthProvider["authorize"]>[2];

  try {
    await provider.authorize(
      client,
      {
        redirectUri,
        codeChallenge: "challenge",
        scopes: ["devspace"],
      },
      response,
    );
    assert.equal(statusCode, 200);
    assert.match(responseBody, /name="resource" value="https:\/\/agent\.example\.com\/mcp"/);

    await assert.rejects(
      provider.authorize(
        client,
        {
          redirectUri,
          codeChallenge: "challenge",
          scopes: ["devspace"],
          resource: new URL("https://other.example/mcp"),
        },
        response,
      ),
      /Invalid OAuth resource/,
    );
  } finally {
    provider.close();
  }
}

async function testDeviceBoundAuthorization(stateDir: string): Promise<void> {
  const loopbackPort = await reservePort();
  const deviceRedirectUri = "https://chatshare.xyz/connector/oauth/device-test";
  const provider = new SingleUserOAuthProvider(
    {
      ...oauthConfig,
      allowedRedirectHosts: ["chatshare.xyz"],
      deviceAuthorization: {
        ...oauthConfig.deviceAuthorization,
        enabled: true,
        required: true,
        loopbackPort,
        allowedRedirectPrefixes: ["https://chatshare.xyz/connector/oauth/"],
      },
    },
    mcpUrl,
    stateDir,
  );
  const listener = provider["deviceAuthorization"]?.["listener"];
  assert.ok(listener);
  if (!listener.listening) await once(listener, "listening");

  try {
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [deviceRedirectUri],
      client_name: "Chatshare",
    });
    assert.ok(client);

    const params = {
      redirectUri: deviceRedirectUri,
      codeChallenge: "D".repeat(43),
      scopes: ["devspace"],
      state: "device-state",
      resource: mcpUrl,
    };
    const getResponse = fakeAuthorizationResponse("GET");
    await provider.authorize(client, params, getResponse.response);
    assert.equal(getResponse.statusCode(), 200);
    assert.match(getResponse.body(), /data-devspace-device-auth="required"/);
    assert.doesNotMatch(getResponse.body(), /name="owner_token"/);

    const challenge = hiddenInputValue(getResponse.body(), "device_challenge");
    const binding = hiddenInputValue(getResponse.body(), "device_binding");
    const proof = provider["deviceAuthorization"]?.["sign"](challenge, binding);
    assert.ok(proof);

    const postResponse = fakeAuthorizationResponse("POST", {
      device_challenge: challenge,
      device_binding: binding,
      device_proof: proof,
    });
    await provider.authorize(client, params, postResponse.response);
    assert.equal(postResponse.statusCode(), 302);
    const redirectLocation = postResponse.redirectLocation();
    assert.ok(redirectLocation);
    const authorizationCode = new URL(redirectLocation).searchParams.get("code");
    assert.ok(authorizationCode);

    const issued = await provider.exchangeAuthorizationCode(
      client,
      authorizationCode,
      undefined,
      deviceRedirectUri,
      mcpUrl,
    );
    const verified = await provider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, client.client_id);

    const now = Math.floor(Date.now() / 1000);
    provider["oauthStore"].saveTokenPair({
      accessTokenHash: hashToken("unbound-access-token"),
      accessToken: {
        clientId: client.client_id,
        scopes: ["devspace"],
        expiresAt: now + 3600,
        resource: mcpUrl.href,
        deviceBound: false,
      },
      refreshTokenHash: hashToken("unbound-refresh-token"),
      refreshToken: {
        clientId: client.client_id,
        scopes: ["devspace"],
        expiresAt: now + 3600,
        resource: mcpUrl.href,
        deviceBound: false,
      },
    });
    await assert.rejects(provider.verifyAccessToken("unbound-access-token"), InvalidTokenError);
    await assert.rejects(
      provider.exchangeRefreshToken(client, "unbound-refresh-token", ["devspace"], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    provider.close();
  }
}

function testPersistenceAndTokenHashing(stateDir: string): void {
  const accessToken = "access-token-example";
  const refreshToken = "refresh-token-example";
  const firstStore = new SqliteOAuthStore(stateDir);
  const firstClients = new SqliteOAuthClientsStore(firstStore, oauthConfig.allowedRedirectHosts);
  const client = firstClients.registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });

  firstStore.saveTokenPair({
    accessTokenHash: hashToken(accessToken),
    accessToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl.href,
    },
    refreshTokenHash: hashToken(refreshToken),
    refreshToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      resource: mcpUrl.href,
    },
  });
  firstStore.close();

  const database = openDatabase(stateDir);
  try {
    const accessHashes = database.sqlite
      .prepare("select token_hash from oauth_access_tokens")
      .pluck()
      .all() as string[];
    const refreshHashes = database.sqlite
      .prepare("select token_hash from oauth_refresh_tokens")
      .pluck()
      .all() as string[];
    assert.deepEqual(accessHashes, [hashToken(accessToken)]);
    assert.deepEqual(refreshHashes, [hashToken(refreshToken)]);
    assert.equal(accessHashes.includes(accessToken), false);
    assert.equal(refreshHashes.includes(refreshToken), false);
  } finally {
    database.close();
  }

  const restoredStore = new SqliteOAuthStore(stateDir);
  try {
    const restoredClient = restoredStore.getClient(client.client_id);
    assert.equal(restoredClient?.client_id, client.client_id);
    assert.equal(restoredStore.getAccessToken(hashToken(accessToken))?.resource, mcpUrl.href);
    assert.equal(restoredStore.getRefreshToken(hashToken(refreshToken))?.clientId, client.client_id);
  } finally {
    restoredStore.close();
  }
}

function testExpiredTokenCleanup(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
    redirect_uris: [redirectUri],
  });
  const expiredAt = Math.floor(Date.now() / 1000) - 1;
  store.saveTokenPair({
    accessTokenHash: "expired-access-hash",
    accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
    refreshTokenHash: "expired-refresh-hash",
    refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
  });
  store.close();

  const reopened = new SqliteOAuthStore(stateDir);
  try {
    assert.equal(reopened.getAccessToken("expired-access-hash"), undefined);
    assert.equal(reopened.getRefreshToken("expired-refresh-hash"), undefined);
  } finally {
    reopened.close();
  }
}

function testTransactionalTokenRotation(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
      redirect_uris: [redirectUri],
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    store.saveRefreshToken("old-refresh-hash", {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt,
    });

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "new-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "new-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      true,
    );
    assert.equal(store.getRefreshToken("old-refresh-hash"), undefined);
    assert.ok(store.getAccessToken("new-access-hash"));
    assert.ok(store.getRefreshToken("new-refresh-hash"));

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "losing-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "losing-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      false,
    );
    assert.equal(store.getAccessToken("losing-access-hash"), undefined);
    assert.equal(store.getRefreshToken("losing-refresh-hash"), undefined);
  } finally {
    store.close();
  }
}

async function testProviderRestartRotationAndRevocation(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  assert.ok(client);

  const code = "code-test-123";
  firstProvider["codes"].set(code, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() + 60_000,
    deviceBound: false,
  });
  const issued = await firstProvider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    redirectUri,
    mcpUrl,
  );
  assert.ok(issued.refresh_token);
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    const verified = await secondProvider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, client.client_id);

    const refreshed = await secondProvider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      ["devspace"],
      mcpUrl,
    );
    assert.ok(refreshed.refresh_token);
    assert.notEqual(refreshed.access_token, issued.access_token);

    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, issued.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );

    await secondProvider.revokeToken(client, { token: refreshed.access_token });
    await assert.rejects(secondProvider.verifyAccessToken(refreshed.access_token), InvalidTokenError);

    await secondProvider.revokeToken(client, { token: refreshed.refresh_token });
    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, refreshed.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    secondProvider.close();
  }
}

function fakeAuthorizationResponse(
  method: "GET" | "POST",
  requestBody: Record<string, string> = {},
): {
  response: Parameters<SingleUserOAuthProvider["authorize"]>[2];
  statusCode(): number;
  body(): string;
  redirectLocation(): string;
} {
  let currentStatusCode = 0;
  let responseBody = "";
  let location = "";
  const response = {
    req: { method, body: requestBody },
    status(code: number) {
      currentStatusCode = code;
      return this;
    },
    setHeader() {
      return this;
    },
    send(body: unknown) {
      responseBody = String(body);
      return this;
    },
    redirect(code: number, url: string) {
      currentStatusCode = code;
      location = url;
      return this;
    },
  } as unknown as Parameters<SingleUserOAuthProvider["authorize"]>[2];

  return {
    response,
    statusCode: () => currentStatusCode,
    body: () => responseBody,
    redirectLocation: () => location,
  };
}

function hiddenInputValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  assert.ok(match, `Expected hidden input ${name}`);
  return match[1];
}

async function reservePort(): Promise<number> {
  const server = createHttpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

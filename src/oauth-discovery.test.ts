import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const stateDir = await mkdtemp(join(tmpdir(), "devspace-oidc-discovery-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: stateDir,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_ALLOWED_HOSTS: "127.0.0.1,localhost,devspace.example.test",
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.test",
  DEVSPACE_DEVICE_AUTH: "0",
  HOST: "127.0.0.1",
});
const { app, close } = createServer(config);
const httpServer = app.listen(0, "127.0.0.1");

try {
  await once(httpServer, "listening");
  const { port } = httpServer.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const [protectedResourceResponse, oauthResponse, oidcResponse] = await Promise.all([
    fetch(`${origin}/.well-known/oauth-protected-resource/mcp`),
    fetch(`${origin}/.well-known/oauth-authorization-server`),
    fetch(`${origin}/.well-known/openid-configuration`),
  ]);

  assert.equal(protectedResourceResponse.status, 200);
  assert.equal(oauthResponse.status, 200);
  assert.equal(oidcResponse.status, 200);
  assert.equal(oidcResponse.headers.get("access-control-allow-origin"), "*");

  const protectedResourceMetadata = await protectedResourceResponse.json();
  const oauthMetadata = await oauthResponse.json();
  const oidcMetadata = await oidcResponse.json();
  assert.equal(protectedResourceMetadata.resource, "https://devspace.example.test/mcp");
  assert.deepEqual(protectedResourceMetadata.authorization_servers, ["https://devspace.example.test/"]);
  assert.deepEqual(oidcMetadata, oauthMetadata);
  assert.equal(oidcMetadata.issuer, "https://devspace.example.test/");
  assert.equal(oidcMetadata.authorization_endpoint, "https://devspace.example.test/authorize");
  assert.equal(oidcMetadata.token_endpoint, "https://devspace.example.test/token");
  assert.equal(oidcMetadata.registration_endpoint, "https://devspace.example.test/register");
} finally {
  httpServer.close();
  await close();
  await rm(stateDir, { recursive: true, force: true });
}

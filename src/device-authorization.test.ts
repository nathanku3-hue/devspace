import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { DeviceAuthorization, type DeviceAuthorizationConfig } from "./device-authorization.js";

const extensionId = "aaoelopmdnhifffjefciagfmhjanbaoc";
const port = await reservePort();
const config: DeviceAuthorizationConfig = {
  enabled: true,
  required: true,
  loopbackPort: port,
  extensionId,
  allowedRedirectPrefixes: [
    "https://chatshare.xyz/connector/oauth/",
    "https://chatshare.xyz/connector_platform_oauth_redirect",
  ],
  challengeTtlSeconds: 60,
};
const authorization = new DeviceAuthorization(config);

assert.equal(
  authorization.isRedirectAllowed("https://chatshare.xyz/connector/oauth/callback-id"),
  true,
);
assert.equal(
  authorization.isRedirectAllowed("https://chatshare.xyz/connector_platform_oauth_redirect?state=one"),
  true,
);
assert.equal(
  authorization.isRedirectAllowed("https://chatshare.xyz.evil.example/connector/oauth/callback-id"),
  false,
);
assert.equal(
  authorization.isRedirectAllowed("https://chatshare.xyz/connector_platform_oauth_redirect-evil"),
  false,
);

const directBinding = "A".repeat(43);
const directChallenge = authorization.createChallenge(directBinding);
const directProof = authorization["sign"](directChallenge, directBinding);
assert.equal(authorization.verifyProof(directChallenge, directBinding, directProof), true);
assert.equal(authorization.verifyProof(directChallenge, directBinding, directProof), false);

const wrongBindingChallenge = authorization.createChallenge(directBinding);
assert.equal(
  authorization.verifyProof(
    wrongBindingChallenge,
    "B".repeat(43),
    authorization["sign"](wrongBindingChallenge, directBinding),
  ),
  false,
);

authorization.start();
const listener = authorization["listener"];
assert.ok(listener);
if (!listener.listening) await once(listener, "listening");

try {
  const binding = "C".repeat(43);
  const challenge = authorization.createChallenge(binding);
  const accepted = await postProof({
    port,
    origin: authorization.extensionOrigin,
    extensionId,
    challenge,
    binding,
  });
  assert.equal(accepted.status, 200);
  assert.equal(typeof accepted.body.deviceId, "string");
  assert.match(String(accepted.body.proof), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    authorization.verifyProof(challenge, binding, String(accepted.body.proof)),
    true,
  );

  const rejectedOrigin = await postProof({
    port,
    origin: "https://evil.example",
    extensionId,
    challenge: authorization.createChallenge(binding),
    binding,
  });
  assert.equal(rejectedOrigin.status, 403);

  const rejectedExtension = await postProof({
    port,
    origin: authorization.extensionOrigin,
    extensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    challenge: authorization.createChallenge(binding),
    binding,
  });
  assert.equal(rejectedExtension.status, 403);
} finally {
  authorization.close();
}

async function reservePort(): Promise<number> {
  const server = createHttpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const selectedPort = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return selectedPort;
}

async function postProof(params: {
  port: number;
  origin: string;
  extensionId: string;
  challenge: string;
  binding: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify({
    challenge: params.challenge,
    binding: params.binding,
  });

  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: params.port,
        path: "/devspace-device-proof",
        method: "POST",
        headers: {
          Host: `127.0.0.1:${params.port}`,
          Origin: params.origin,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "X-DevSpace-Extension-Id": params.extensionId,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: response.statusCode ?? 0,
              body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

"use strict";

const DEVSPACE_ORIGIN = "https://devspace-proxy.kitlongku.workers.dev";
const DEVSPACE_AUTHORIZE_PATH = "/authorize";
const LOOPBACK_PROOF_URL = "http://127.0.0.1:7677/devspace-device-proof";
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "devspace-device-proof") return false;

  void createDeviceProof(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));

  return true;
});

async function createDeviceProof(message, sender) {
  const senderUrl = new URL(sender.url ?? "");
  if (senderUrl.origin !== DEVSPACE_ORIGIN || senderUrl.pathname !== DEVSPACE_AUTHORIZE_PATH) {
    throw new Error("Device proof request came from an untrusted page.");
  }

  const challenge = String(message.challenge ?? "");
  const binding = String(message.binding ?? "");
  if (!BASE64URL_SHA256.test(challenge) || !BASE64URL_SHA256.test(binding)) {
    throw new Error("Device proof request is malformed.");
  }

  const response = await fetch(LOOPBACK_PROOF_URL, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      "X-DevSpace-Extension-Id": chrome.runtime.id,
    },
    body: JSON.stringify({ challenge, binding }),
  });

  if (!response.ok) {
    throw new Error(`The enrolled-PC signer rejected the request (${response.status}).`);
  }

  const body = await response.json();
  const proof = String(body?.proof ?? "");
  const deviceId = String(body?.deviceId ?? "");
  if (!BASE64URL_SHA256.test(proof)) {
    throw new Error("The enrolled-PC signer returned an invalid proof.");
  }

  return { proof, deviceId };
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

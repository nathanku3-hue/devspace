import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const expectedExtensionId = "aaoelopmdnhifffjefciagfmhjanbaoc";
const expectedDevspaceOrigin = "https://devspace-proxy.kitlongku.workers.dev";
const expectedLoopbackUrl = "http://127.0.0.1:7677/devspace-device-proof";
const proof = "P".repeat(43);

const manifest = JSON.parse(
  await readFile(new URL("./manifest.json", import.meta.url), "utf8"),
);
assert.equal(extensionIdFromManifestKey(manifest.key), expectedExtensionId);
assert.equal(manifest.background.service_worker, "device-proof-background.js");
assert.ok(manifest.host_permissions.includes(`${expectedDevspaceOrigin}/*`));
assert.ok(manifest.host_permissions.includes("http://127.0.0.1:7677/*"));
assert.ok(
  manifest.content_scripts.some(
    (entry) =>
      entry.matches.includes(`${expectedDevspaceOrigin}/authorize*`) &&
      entry.js.includes("device-authorization.js"),
  ),
);

await testBackgroundRelay();
await testContentScriptSubmission();
console.log("Device authorization extension tests passed.");

async function testBackgroundRelay() {
  const source = await readFile(
    new URL("./device-proof-background.js", import.meta.url),
    "utf8",
  );
  let messageListener;
  const fetchCalls = [];
  const context = {
    URL,
    Error,
    String,
    JSON,
    console,
    chrome: {
      runtime: {
        id: expectedExtensionId,
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
      },
    },
    async fetch(url, options) {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return { proof, deviceId: "device-test" };
        },
      };
    },
  };
  vm.runInNewContext(source, context, { filename: "device-proof-background.js" });
  assert.equal(typeof messageListener, "function");

  const challenge = "C".repeat(43);
  const binding = "B".repeat(43);
  const accepted = await sendBackgroundMessage(messageListener, {
    message: { type: "devspace-device-proof", challenge, binding },
    sender: { url: `${expectedDevspaceOrigin}/authorize?client_id=test` },
  });
  assert.deepEqual({ ...accepted }, {
    ok: true,
    proof,
    deviceId: "device-test",
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, expectedLoopbackUrl);
  assert.equal(
    fetchCalls[0].options.headers["X-DevSpace-Extension-Id"],
    expectedExtensionId,
  );
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), { challenge, binding });

  const rejected = await sendBackgroundMessage(messageListener, {
    message: { type: "devspace-device-proof", challenge, binding },
    sender: { url: "https://evil.example/authorize" },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /untrusted page/i);
  assert.equal(fetchCalls.length, 1);
}

async function testContentScriptSubmission() {
  const source = await readFile(
    new URL("./device-authorization.js", import.meta.url),
    "utf8",
  );

  class MockInput {
    constructor(value = "") {
      this.value = value;
    }
  }
  class MockButton {
    constructor() {
      this.disabled = false;
      this.listeners = new Map();
    }
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }
  }
  class MockForm {
    constructor(inputs) {
      this.dataset = {};
      this.submissions = 0;
      this.elements = {
        namedItem: (name) => inputs[name] ?? null,
      };
    }
    requestSubmit() {
      this.submissions += 1;
    }
  }

  const inputs = {
    device_challenge: new MockInput("C".repeat(43)),
    device_binding: new MockInput("B".repeat(43)),
    device_proof: new MockInput(),
  };
  const form = new MockForm(inputs);
  const retry = new MockButton();
  const statusClasses = new Map();
  const status = {
    textContent: "",
    classList: {
      toggle(name, enabled) {
        statusClasses.set(name, enabled);
      },
    },
  };
  const messages = [];
  const context = {
    HTMLFormElement: MockForm,
    HTMLInputElement: MockInput,
    HTMLButtonElement: MockButton,
    Error,
    String,
    console,
    document: {
      querySelector(selector) {
        return selector === 'form[data-devspace-device-auth="required"]'
          ? form
          : null;
      },
      getElementById(id) {
        if (id === "devspace-device-status") return status;
        if (id === "devspace-device-retry") return retry;
        return null;
      },
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          return { ok: true, proof, deviceId: "device-test" };
        },
      },
    },
  };
  vm.runInNewContext(source, context, { filename: "device-authorization.js" });
  await waitFor(() => form.submissions === 1, "device authorization submission");

  assert.equal(messages.length, 1);
  assert.deepEqual({ ...messages[0] }, {
    type: "devspace-device-proof",
    challenge: "C".repeat(43),
    binding: "B".repeat(43),
  });
  assert.equal(inputs.device_proof.value, proof);
  assert.equal(form.dataset.devspaceDeviceAuthState, "submitting");
  assert.match(status.textContent, /verified/i);
  assert.equal(statusClasses.get("error"), false);
}

function extensionIdFromManifestKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest();
  let id = "";
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

async function sendBackgroundMessage(listener, { message, sender }) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for extension background response")),
      2000,
    );
    const keepChannelOpen = listener(message, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    assert.equal(keepChannelOpen, true);
  });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

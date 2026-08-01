import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXPECTED_TOOL_NAMES,
  recordWebConnectorOutcome,
  verifyConnectorReceiptHash,
} from "./web-connector-live-recorder.mjs";

const DEPLOYED_SHA = "0123456789abcdef0123456789abcdef01234567";
const INVOCATION_TIMESTAMP = "2026-08-01T11:30:00.000Z";
const DEFAULT_TIMEOUT_MS = 165_000;

function tools(names = EXPECTED_TOOL_NAMES) {
  return names.map((name) => ({ name }));
}

function acknowledgement() {
  return {
    slice: "WEB-CONNECTOR-1",
    connectorDiscovered: true,
    connectorInvoked: true,
    probeTool: "web_connector_probe",
    conversationIdentitySha256: "a".repeat(64),
    invocationTimestamp: INVOCATION_TIMESTAMP,
    assistantOutputCaptured: false,
  };
}

function fakeClient({ result, callError, listed = { tools: tools() }, close, onCall } = {}) {
  return {
    async listTools() {
      return listed;
    },
    async callTool(params, resultSchema, options) {
      onCall?.({ params, resultSchema, options });
      if (callError) throw callError;
      return result;
    },
    async close() {
      await close?.();
    },
  };
}

function monotonic(values = [100, 110, 235, 250]) {
  const remaining = [...values];
  const fallback = remaining.at(-1) ?? 0;
  return () => remaining.shift() ?? fallback;
}

async function withRecorder(testBody) {
  const directory = await mkdtemp(join(tmpdir(), "web-connector-recorder-test-"));
  const outputPath = join(directory, "receipt.json");
  try {
    await testBody({ directory, outputPath });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

async function run({ outputPath, client, requestTimeoutMs = DEFAULT_TIMEOUT_MS, monotonicNow } = {}) {
  return recordWebConnectorOutcome({
    client,
    outputPath,
    deployedSha: DEPLOYED_SHA,
    requestTimeoutMs,
    now: () => new Date("2026-08-01T11:29:00.000Z"),
    monotonicNow: monotonicNow ?? monotonic(),
  });
}

async function readReceipt(outputPath) {
  return JSON.parse(await readFile(outputPath, "utf8"));
}

test("retains successful acknowledgement, exact inventory, counts, duration, and timeout", async () => {
  await withRecorder(async ({ outputPath }) => {
    let recordedCall;
    const result = {
      content: [{ type: "text", text: "WEB-CONNECTOR-1 proof succeeded." }],
      structuredContent: acknowledgement(),
    };
    const outcome = await run({
      outputPath,
      client: fakeClient({
        result,
        onCall: (call) => {
          recordedCall = call;
        },
      }),
    });

    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(recordedCall.params, { name: "web_connector_proof", arguments: {} });
    assert.equal(recordedCall.resultSchema, undefined);
    assert.deepEqual(recordedCall.options, { timeout: DEFAULT_TIMEOUT_MS });
    assert.deepEqual(outcome.receipt.authenticatedToolInventory, [...EXPECTED_TOOL_NAMES]);
    assert.equal(outcome.receipt.toolCount, 12);
    assert.equal(outcome.receipt.webConnectorProofCount, 1);
    assert.equal(outcome.receipt.webConnectorProbeCount, 1);
    assert.equal(outcome.receipt.requestTimeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(outcome.receipt.callDurationMs, 125);
    assert.equal(outcome.receipt.elapsedMs, 150);
    assert.equal(outcome.receipt.callReturned, true);
    assert.equal(outcome.receipt.isError, false);
    assert.deepEqual(outcome.receipt.content, result.content);
    assert.deepEqual(outcome.receipt.structuredContent, result.structuredContent);
    assert.equal(outcome.receipt.transportProtocolError, null);
    assert.equal(outcome.receipt.recorderError, null);
    assert.equal(verifyConnectorReceiptHash(outcome.receipt), true);
  });
});

test("distinguishes the server probe timeout from the client request timeout", async () => {
  await withRecorder(async ({ outputPath }) => {
    const diagnostic =
      "WEB-CONNECTOR-1 timed out waiting for the spawned conversation to invoke DevSpace";
    const outcome = await run({
      outputPath,
      client: fakeClient({
        result: {
          isError: true,
          content: [{ type: "text", text: diagnostic }],
        },
      }),
    });

    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.receipt.callReturned, true);
    assert.equal(outcome.receipt.isError, true);
    assert.equal(outcome.receipt.failureKind, "SERVER_PROBE_TIMEOUT");
    assert.deepEqual(outcome.receipt.content, [{ type: "text", text: diagnostic }]);
    assert.equal(outcome.receipt.transportProtocolError, null);
  });

  await withRecorder(async ({ outputPath }) => {
    const timeoutError = Object.assign(new Error("Request timed out"), { code: -32001 });
    const outcome = await run({
      outputPath,
      client: fakeClient({ callError: timeoutError }),
    });

    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.receipt.callReturned, false);
    assert.equal(outcome.receipt.isError, null);
    assert.equal(outcome.receipt.failureKind, "CLIENT_REQUEST_TIMEOUT");
    assert.equal(outcome.receipt.transportProtocolError.code, -32001);
    assert.match(outcome.receipt.transportProtocolError.message, /request timed out/i);
    assert.deepEqual(outcome.receipt.content, []);
  });
});

test("retains non-timeout transport and protocol errors separately", async () => {
  await withRecorder(async ({ outputPath }) => {
    const transportError = Object.assign(new Error("MCP transport disconnected"), {
      code: -32000,
      data: { phase: "tools/call" },
    });
    const outcome = await run({
      outputPath,
      client: fakeClient({ callError: transportError }),
    });

    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.receipt.callReturned, false);
    assert.equal(outcome.receipt.failureKind, "TRANSPORT_OR_PROTOCOL_ERROR");
    assert.equal(outcome.receipt.transportProtocolError.code, -32000);
    assert.match(outcome.receipt.transportProtocolError.message, /transport disconnected/);
    assert.deepEqual(outcome.receipt.transportProtocolError.data, { phase: "tools/call" });
  });
});

test("awaits graceful client closure and atomic receipt creation before returning", async () => {
  await withRecorder(async ({ directory, outputPath }) => {
    let closed = false;
    const outcome = await run({
      outputPath,
      client: fakeClient({
        result: { content: [], structuredContent: acknowledgement() },
        close: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          closed = true;
        },
      }),
    });

    assert.equal(closed, true);
    assert.equal(outcome.exitCode, 0);
    assert.equal((await stat(outputPath)).isFile(), true);
    assert.deepEqual(await readReceipt(outputPath), outcome.receipt);
    const directoryEntries = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
    assert.deepEqual(directoryEntries, ["receipt.json"]);
  });
});

test("malformed success acknowledgement fails closed", async () => {
  await withRecorder(async ({ outputPath }) => {
    const malformed = {
      ...acknowledgement(),
      connectorInvoked: false,
    };
    const outcome = await run({
      outputPath,
      client: fakeClient({
        result: {
          isError: false,
          content: [{ type: "text", text: "claimed success" }],
          structuredContent: malformed,
        },
      }),
    });

    assert.equal(outcome.exitCode, 4);
    assert.equal(outcome.receipt.callReturned, true);
    assert.equal(outcome.receipt.recorderError, "MALFORMED_SUCCESS_ACKNOWLEDGEMENT");
    assert.equal(outcome.receipt.failureKind, "RECORDER_VALIDATION_FAILURE");
    assert.deepEqual(outcome.receipt.structuredContent, malformed);
  });
});

test("requires exactly 12 tools with one proof and one probe before invoking", async () => {
  await withRecorder(async ({ outputPath }) => {
    let callCount = 0;
    const wrongInventory = [...EXPECTED_TOOL_NAMES];
    wrongInventory[wrongInventory.indexOf("write")] = "web_connector_proof";
    const outcome = await run({
      outputPath,
      client: fakeClient({
        listed: { tools: tools(wrongInventory) },
        result: { content: [], structuredContent: acknowledgement() },
        onCall: () => {
          callCount += 1;
        },
      }),
    });

    assert.equal(outcome.exitCode, 4);
    assert.equal(callCount, 0);
    assert.equal(outcome.receipt.callReturned, false);
    assert.equal(outcome.receipt.toolCount, 12);
    assert.equal(outcome.receipt.webConnectorProofCount, 2);
    assert.equal(outcome.receipt.webConnectorProbeCount, 1);
    assert.equal(outcome.receipt.failureKind, "INVENTORY_FAILURE");
    assert.match(outcome.receipt.recorderError, /TOOL_INVENTORY_MISMATCH/);
  });
});

test("redacts credentials, browser HTML, images, and assistant-output fields", async () => {
  await withRecorder(async ({ outputPath }) => {
    const result = {
      isError: true,
      content: [
        { type: "text", text: "Authorization: Bearer abc.def.ghi" },
        { type: "text", text: "<!doctype html><html><body>private browser page</body></html>" },
      ],
      structuredContent: {
        access_token: "do-not-store",
        screenshot: "data:image/png;base64,AAAA",
        assistant_output: "do-not-store-response",
      },
    };
    const outcome = await run({ outputPath, client: fakeClient({ result }) });
    const serialized = JSON.stringify(outcome.receipt);

    assert.equal(serialized.includes("abc.def.ghi"), false);
    assert.equal(serialized.includes("private browser page"), false);
    assert.equal(serialized.includes("do-not-store"), false);
    assert.equal(serialized.includes("do-not-store-response"), false);
    assert.match(serialized, /REDACTED_SENSITIVE/);
    assert.match(serialized, /REDACTED_HTML/);
  });
});

test("receipt hash detects edits", async () => {
  await withRecorder(async ({ outputPath }) => {
    const outcome = await run({
      outputPath,
      client: fakeClient({ result: { content: [], structuredContent: acknowledgement() } }),
    });
    assert.equal(verifyConnectorReceiptHash(outcome.receipt), true);

    const edited = { ...outcome.receipt, callDurationMs: outcome.receipt.callDurationMs + 1 };
    assert.equal(verifyConnectorReceiptHash(edited), false);
  });
});

test("rejects a client timeout below the acceptance safety floor", async () => {
  await withRecorder(async ({ outputPath }) => {
    await assert.rejects(
      run({
        outputPath,
        requestTimeoutMs: 149_999,
        client: fakeClient({ result: { content: [], structuredContent: acknowledgement() } }),
      }),
      /at least 150000/,
    );
  });
});

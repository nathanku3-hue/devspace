import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  recordWebLaunchOutcome,
  verifyReceiptHash,
} from "./web-launch-live-recorder.mjs";

const DEPLOYED_SHA = "1257f64fed29e831a379f307899da940a5f7fab7";
const PROMPT = "RECORDER-0 sentinel prompt: preserve diagnostics only.";

function tools() {
  return Array.from({ length: 9 }, (_, index) => ({ name: `tool_${index}` })).concat({
    name: "web_launch",
  });
}

function acknowledgement() {
  return {
    slice: "WEB-LAUNCH-0",
    launchSuccess: true,
    conversationIdentitySha256: "a".repeat(64),
    timestamp: "2026-08-01T03:30:00.000Z",
    assistantOutputCaptured: false,
  };
}

function fakeClient({ result, callError, listed = { tools: tools() }, close } = {}) {
  return {
    async listTools() {
      return listed;
    },
    async callTool() {
      if (callError) throw callError;
      return result;
    },
    async close() {
      await close?.();
    },
  };
}

async function withRecorder(testBody) {
  const directory = await mkdtemp(join(tmpdir(), "web-launch-recorder-test-"));
  const outputPath = join(directory, "receipt.json");
  try {
    await testBody({ directory, outputPath });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

async function run({ outputPath, client, prompt = PROMPT }) {
  return recordWebLaunchOutcome({
    client,
    outputPath,
    prompt,
    deployedSha: DEPLOYED_SHA,
    now: () => new Date("2026-08-01T03:30:00.000Z"),
    monotonicNow: (() => {
      const values = [100, 225];
      return () => values.shift() ?? 225;
    })(),
  });
}

async function readReceipt(outputPath) {
  return JSON.parse(await readFile(outputPath, "utf8"));
}

test("preserves isError diagnostics returned only through ordinary content", async () => {
  await withRecorder(async ({ outputPath }) => {
    const diagnostic = "PROMPT_INSERTION_TIMEOUT: textarea read-back never matched";
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
    assert.deepEqual(outcome.receipt.content, [{ type: "text", text: diagnostic }]);
    assert.equal(outcome.receipt.structuredContent, null);
    assert.equal(outcome.receipt.transportError, null);
    assert.equal(verifyReceiptHash(outcome.receipt), true);
  });
});

test("preserves successful structuredContent and ordinary content", async () => {
  await withRecorder(async ({ outputPath }) => {
    const result = {
      content: [{ type: "text", text: "Launch acknowledged." }],
      structuredContent: acknowledgement(),
      _meta: { stage: "conversation-identity-established" },
    };
    const outcome = await run({ outputPath, client: fakeClient({ result }) });

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.receipt.isError, false);
    assert.deepEqual(outcome.receipt.content, result.content);
    assert.deepEqual(outcome.receipt.structuredContent, result.structuredContent);
    assert.deepEqual(outcome.receipt.meta, result._meta);
  });
});

test("preserves a thrown transport exception separately", async () => {
  await withRecorder(async ({ outputPath }) => {
    const outcome = await run({
      outputPath,
      client: fakeClient({ callError: new Error("MCP transport disconnected") }),
    });

    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.receipt.callReturned, false);
    assert.equal(outcome.receipt.isError, null);
    assert.match(outcome.receipt.transportError.message, /transport disconnected/);
    assert.deepEqual(outcome.receipt.content, []);
  });
});

test("awaits client closure and atomic artifact creation before returning", async () => {
  await withRecorder(async ({ outputPath }) => {
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
  });
});

test("redacts the literal prompt and sensitive payloads from every receipt field", async () => {
  await withRecorder(async ({ outputPath }) => {
    const result = {
      isError: true,
      content: [
        { type: "text", text: `Failed while inserting ${PROMPT}` },
        { type: "text", text: "Authorization: Bearer abc.def.ghi" },
        { type: "text", text: "<!doctype html><html><body>private page</body></html>" },
      ],
      _meta: {
        promptEcho: PROMPT,
        access_token: "do-not-store",
        screenshot: "data:image/png;base64,AAAA",
      },
    };
    const outcome = await run({ outputPath, client: fakeClient({ result }) });
    const serialized = JSON.stringify(outcome.receipt);

    assert.equal(serialized.includes(PROMPT), false);
    assert.equal(serialized.includes("do-not-store"), false);
    assert.equal(serialized.includes("private page"), false);
    assert.match(serialized, /REDACTED_PROMPT/);
    assert.match(serialized, /REDACTED_SENSITIVE/);
    assert.match(serialized, /REDACTED_HTML/);
  });
});

test("returns zero only for a valid acknowledgement and non-zero for tool failure", async () => {
  await withRecorder(async ({ outputPath }) => {
    const success = await run({
      outputPath,
      client: fakeClient({ result: { content: [], structuredContent: acknowledgement() } }),
    });
    assert.equal(success.exitCode, 0);
  });

  await withRecorder(async ({ outputPath }) => {
    const failure = await run({
      outputPath,
      client: fakeClient({ result: { isError: true, content: [{ type: "text", text: "failed" }] } }),
    });
    assert.notEqual(failure.exitCode, 0);
  });
});

test("malformed results fail closed instead of producing false success", async () => {
  await withRecorder(async ({ outputPath }) => {
    const outcome = await run({
      outputPath,
      client: fakeClient({
        result: {
          isError: false,
          content: "not-an-array",
          structuredContent: acknowledgement(),
        },
      }),
    });

    assert.equal(outcome.exitCode, 4);
    assert.equal(outcome.receipt.recorderError, "MALFORMED_CONTENT");
    assert.equal(outcome.receipt.callReturned, true);
  });
});

test("receipt hash detects later edits", async () => {
  await withRecorder(async ({ outputPath }) => {
    const outcome = await run({
      outputPath,
      client: fakeClient({ result: { content: [], structuredContent: acknowledgement() } }),
    });
    assert.equal(verifyReceiptHash(outcome.receipt), true);

    const edited = { ...outcome.receipt, elapsedMs: outcome.receipt.elapsedMs + 1 };
    assert.equal(verifyReceiptHash(edited), false);
  });
});

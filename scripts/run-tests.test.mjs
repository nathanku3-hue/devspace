import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTestArgs, runTestSuite, TEST_GROUPS } from "./run-tests.mjs";

const silent = { write() {} };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "devspace-test-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const nodeCase = (name, script) => ({
  name,
  command: process.execPath,
  args: ["-e", script],
});

test("runner persists every group, logs output and fails on any nonzero exit", async (t) => {
  const root = await fixture(t);
  const result = await runTestSuite([
    { name: "ok", cases: [nodeCase("passing", "console.log('pass-marker')")] },
    { name: "bad", cases: [nodeCase("failing", "console.error('fail-marker');process.exit(7)")] },
  ], {
    rootDir: root, resultsRoot: join(root, "artifacts"), timeoutMs: 10_000,
    output: silent, errorOutput: silent,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.status, "failed");
  assert.deepEqual(result.summary.totals, { passed: 1, failed: 1, timedOut: 0 });
  assert.deepEqual(result.summary.groups.map((group) => group.status), ["passed", "failed"]);
  assert.match(await readFile(join(result.runDir, "ok", "group.log"), "utf8"), /pass-marker/);
  assert.match(await readFile(join(result.runDir, "bad", "group.log"), "utf8"), /fail-marker/);
  const persisted = JSON.parse(await readFile(join(result.runDir, "summary.json"), "utf8"));
  assert.deepEqual(persisted, result.summary);
  assert.equal(persisted.groups[1].cases[0].exitCode, 7);
  assert.ok(persisted.finishedAt);
});

test("runner marks hung tests timed_out and returns nonzero", async (t) => {
  const root = await fixture(t);
  const result = await runTestSuite([
    { name: "timeout", cases: [nodeCase("stuck", "setInterval(() => {}, 1000)")] },
  ], {
    rootDir: root, resultsRoot: join(root, "artifacts"), timeoutMs: 1500,
    output: silent, errorOutput: silent,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.totals.timedOut, 1);
  assert.equal(result.summary.groups[0].cases[0].status, "timed_out");
});

test("runner rejects unknown groups and preserves explicit group selection", () => {
  assert.throws(() => parseTestArgs(["--group", "unknown"]), /Unknown test group/);
  assert.throws(() => parseTestArgs(["--group"]), /incomplete/);
  assert.deepEqual(parseTestArgs(["--group", "auth-mcp"]), {
    group: "auth-mcp", resultsDir: undefined, list: false,
  });
  assert.equal(TEST_GROUPS.find((group) => group.name === "auth-mcp").cases.at(-1).name,
    "mcp-modern-server");
});

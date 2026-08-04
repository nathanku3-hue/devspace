import assert from "node:assert/strict";
import { ExecutionBusyError, ExecutionGate } from "./execution-gate.js";

const gate = new ExecutionGate("validation", 1, 2);
let releaseFirst!: () => void;
const first = gate.run(
  () =>
    new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }),
);

let secondStarted = false;
let queuedPosition = 0;
const second = gate.run(
  async () => {
    secondStarted = true;
    return "second";
  },
  { onQueued: (position) => (queuedPosition = position) },
);
assert.equal(gate.active, 1);
assert.equal(gate.queued, 1);
assert.equal(queuedPosition, 1);
assert.equal(secondStarted, false);

const abortController = new AbortController();
const cancelled = gate.run(async () => "cancelled", {
  signal: abortController.signal,
});
assert.equal(gate.queued, 2);
abortController.abort();
await assert.rejects(cancelled, (error: unknown) => {
  return error instanceof Error && error.name === "AbortError";
});
assert.equal(gate.queued, 1);

const third = gate.run(async () => "third");
await assert.rejects(
  gate.run(async () => "overflow"),
  (error: unknown) => error instanceof ExecutionBusyError && error.code === "EXECUTION_BUSY",
);

releaseFirst();
await first;
assert.equal(await second, "second");
assert.equal(await third, "third");
assert.equal(gate.active, 0);
assert.equal(gate.queued, 0);

const callbackGate = new ExecutionGate("callback", 1, 1);
let releaseCallback!: () => void;
const callbackFirst = callbackGate.run(
  () =>
    new Promise<void>((resolve) => {
      releaseCallback = resolve;
    }),
);
const callbackQueued = callbackGate.run(async () => "visible", {
  onQueued: () => {
    throw new Error("progress channel failed");
  },
});
releaseCallback();
await callbackFirst;
assert.equal(await callbackQueued, "visible");
assert.equal(callbackGate.active, 0);
assert.equal(callbackGate.queued, 0);

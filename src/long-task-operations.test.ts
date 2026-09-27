import assert from "node:assert/strict";
import { LongTaskOperationManager } from "./long-task-operations.js";

async function waitFor(
  probe: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for long-task operation state");
}

const manager = new LongTaskOperationManager<{ output: string }>(3);
const completed = manager.start("shell", "ws_complete", async ({ update }) => {
  update("running", "fixture running");
  return { output: "done" };
});
assert.match(completed.operationId, /^operation_[0-9a-f-]{36}$/);
assert.equal(completed.status, "queued");

// Verify op.completion resolves to final snapshot
const completionResult = await completed.completion;
assert.equal(completionResult.status, "succeeded");
assert.deepEqual(completionResult.result, { output: "done" });
assert.deepEqual(manager.get(completed.operationId).result, { output: "done" });

// Verify failure handling
const failed = manager.start("validation", "ws_failed", async ({ update }) => {
  update("running", "fixture failing");
  throw new Error("fixture failure");
});
const failedOutcome = await failed.completion;
assert.equal(failedOutcome.status, "failed");
assert.match(failedOutcome.error ?? "", /fixture failure/);

// Verify cancellation handling
let cancellationObserved = false;
const cancelled = manager.start("shell", "ws_cancel", async ({ signal, update }) => {
  update("running", "fixture waiting");
  await new Promise<void>((resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        cancellationObserved = true;
        const error = new Error("cancelled by fixture");
        error.name = "AbortError";
        reject(error);
      },
      { once: true },
    );
  });
  return { output: "unreachable" };
});
await waitFor(() => manager.get(cancelled.operationId).status === "running");
assert.equal(manager.cancel(cancelled.operationId).status, "cancelling");
const cancelledOutcome = await cancelled.completion;
assert.equal(cancelledOutcome.status, "cancelled");
assert.equal(cancellationObserved, true);
assert.ok(manager.get(cancelled.operationId).completedAt);

// Verify eviction when capacity reached
const replacement = manager.start("shell", "ws_replacement", async () => ({
  output: "replacement",
}));
await replacement.completion;
assert.throws(() => manager.get(completed.operationId), /Unknown long-task operation/);
assert.equal(manager.tryGet(completed.operationId), undefined);
assert.equal(manager.tryCancel(completed.operationId), undefined);
assert.equal(manager.cancel(replacement.operationId).status, "succeeded");

// Cancellation is safe immediately after enqueue, before the run microtask starts.
const immediatelyCancelled = manager.start("shell", "ws_immediate", async () => ({
  output: "unreachable",
}));
const immediateCancelSnapshot = manager.tryCancel(immediatelyCancelled.operationId);
assert.ok(immediateCancelSnapshot);
assert.equal(immediateCancelSnapshot.status, "cancelling");
assert.equal((await immediatelyCancelled.completion).status, "cancelled");

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
await waitFor(() => manager.get(completed.operationId).status === "succeeded");
assert.deepEqual(manager.get(completed.operationId).result, { output: "done" });

const failed = manager.start("validation", "ws_failed", async ({ update }) => {
  update("running", "fixture failing");
  throw new Error("fixture failure");
});
await waitFor(() => manager.get(failed.operationId).status === "failed");
assert.match(manager.get(failed.operationId).error ?? "", /fixture failure/);

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
await waitFor(() => manager.get(cancelled.operationId).status === "cancelled");
assert.equal(cancellationObserved, true);
assert.ok(manager.get(cancelled.operationId).completedAt);

const replacement = manager.start("shell", "ws_replacement", async () => ({
  output: "replacement",
}));
await waitFor(() => manager.get(replacement.operationId).status === "succeeded");
assert.throws(() => manager.get(completed.operationId), /Unknown long-task operation/);
assert.equal(manager.cancel(replacement.operationId).status, "succeeded");

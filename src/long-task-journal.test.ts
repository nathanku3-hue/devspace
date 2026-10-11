import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLongTaskJournal } from "./long-task-journal.js";
import { LongTaskOperationManager } from "./long-task-operations.js";

const dir = await mkdtemp(join(tmpdir(), "devspace-operation-journal-"));
try {
  const first = new SqliteLongTaskJournal<{ output: string }>(dir);
  const manager = new LongTaskOperationManager<{ output: string }>(10, first);
  const done = manager.start("shell", "ws_a", async ({ update }) => {
    update("running", "running private command");
    return { output: "private result, not persisted" };
  });
  assert.equal((await done.completion).status, "succeeded");
  const sensitiveFailure = manager.start("shell", "ws_secret", async () => {
    throw new Error("DO_NOT_PERSIST_SECRET_STRING");
  });
  assert.equal((await sensitiveFailure.completion).status, "failed");
  first.save({
    operationId: "operation_interrupted", kind: "shell", workspaceId: "ws_b",
    status: "running", createdAt: new Date().toISOString(),
    progress: "running potentially effectful command",
  });
  first.close();

  const afterRestart = new SqliteLongTaskJournal<{ output: string }>(dir);
  const recovered = new LongTaskOperationManager<{ output: string }>(10, afterRestart);
  assert.equal(recovered.get(done.operationId).status, "succeeded");
  assert.equal(recovered.get(done.operationId).result, undefined, "sensitive output is not durable");
  assert.equal(recovered.get(sensitiveFailure.operationId).error, "execution_failed_details_not_persisted");
  assert.equal(recovered.get("operation_interrupted").status, "unknown");
  assert.equal(recovered.get("operation_interrupted").error, "execution_outcome_unknown_after_restart");
  assert.equal(recovered.tryCancel("operation_interrupted")?.status, "unknown");
  afterRestart.close();
} finally {
  // On Windows, SQLite WAL handles may remain transiently open after close.
  // Cleanup must not erase functional assertions or hang the test runner.
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== "win32" || !["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
    console.warn("Windows SQLite test-temp cleanup deferred: " + dir);
  }
}

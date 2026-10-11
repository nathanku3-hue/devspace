import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDatabase } from "./db/client.js";
import { durableOperations } from "./db/schema.js";
import type { LongTaskJournal, LongTaskOperationSnapshot } from "./long-task-operations.js";

/**
 * Durable operation *identity and outcome state*, not a command replay queue.
 * On a crashed origin, the Windows supervisor/Job Object handles descendants
 * when activated, but the outcome of a previously running effect is UNKNOWN.
 * Do not persist arbitrary shell commands, stdout or provider credentials.
 */
export class SqliteLongTaskJournal<T = unknown> implements LongTaskJournal<T> {
  private readonly database;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.reconcileOnStartup();
  }

  save(record: LongTaskOperationSnapshot<T>): void {
    const output = record.result === undefined ? undefined :
      createHash("sha256").update(JSON.stringify(record.result)).digest("hex");
    const safe = {
      operationId: record.operationId,
      kind: record.kind,
      workspaceId: record.workspaceId,
      status: record.status,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      progress: record.status,
      diagnostics: record.diagnostics,
      // Shell errors can contain sensitive stdout/stderr: retain only a
      // machine-readable category in the durable record.
      error: record.error === "execution_outcome_unknown_after_restart"
        ? record.error
        : record.error ? "execution_failed_details_not_persisted" : undefined,
      resultDigestSha256: output,
    };
    this.database.db.insert(durableOperations).values({
      operationId: record.operationId,
      snapshotJson: JSON.stringify(safe),
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: durableOperations.operationId,
      set: { snapshotJson: JSON.stringify(safe), updatedAt: new Date().toISOString() },
    }).run();
  }

  find(operationId: string): LongTaskOperationSnapshot<T> | undefined {
    const row = this.database.db.select().from(durableOperations)
      .where(eq(durableOperations.operationId, operationId)).get();
    if (!row) return undefined;
    const snapshot = JSON.parse(row.snapshotJson) as LongTaskOperationSnapshot<T>;
    // The durable record deliberately excludes raw output. Its success/failure
    // status remains useful, but clients must not mistake it for full evidence.
    return { ...snapshot, progress: snapshot.status === "succeeded"
      ? "Operation succeeded before restart; raw result was not persisted. Reconcile output artifacts."
      : snapshot.progress };
  }

  private reconcileOnStartup(): void {
    this.database.sqlite.transaction(() => {
      const entries = this.database.db.select().from(durableOperations).all();
      for (const row of entries) {
        const old = JSON.parse(row.snapshotJson) as LongTaskOperationSnapshot<T>;
        if (!["queued", "running", "cancelling"].includes(old.status)) continue;
        const interrupted = {
          ...old,
          status: "unknown" as const,
          completedAt: new Date().toISOString(),
          progress: "Origin restarted before a durable terminal result; inspect effects before any retry.",
          error: "execution_outcome_unknown_after_restart",
        };
        this.database.db.update(durableOperations).set({
          snapshotJson: JSON.stringify(interrupted),
          updatedAt: new Date().toISOString(),
        }).where(eq(durableOperations.operationId, row.operationId)).run();
      }
    }).immediate();
  }

  close(): void {
    this.database.close();
  }
}

import { randomUUID } from "node:crypto";

export type LongTaskKind = "shell" | "validation";
export type LongTaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface LongTaskJournal<TResult> {
  save(record: LongTaskOperationSnapshot<TResult>): void;
  find(operationId: string): LongTaskOperationSnapshot<TResult> | undefined;
}

export interface LongTaskRunContext {
  signal: AbortSignal;
  update(status: "queued" | "running", progress: string): void;
  updateDiagnostics(fields: Record<string, unknown>): void;
}

export interface LongTaskOperationSnapshot<TResult = unknown> {
  operationId: string;
  kind: LongTaskKind;
  workspaceId: string;
  status: LongTaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  progress: string;
  diagnostics?: Record<string, unknown>;
  result?: TResult;
  error?: string;
}

export interface LongTaskStartedOperation<TResult = unknown>
  extends LongTaskOperationSnapshot<TResult> {
  completion: Promise<LongTaskOperationSnapshot<TResult>>;
}

interface LongTaskOperationRecord<TResult>
  extends LongTaskOperationSnapshot<TResult> {
  controller: AbortController;
  resolveCompletion: (snapshot: LongTaskOperationSnapshot<TResult>) => void;
  completion: Promise<LongTaskOperationSnapshot<TResult>>;
}

function abortError(): Error {
  const error = new Error("Long task cancelled");
  error.name = "AbortError";
  return error;
}

function isTerminal(status: LongTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "unknown";
}

function snapshot<TResult>(
  record: LongTaskOperationRecord<TResult>,
): LongTaskOperationSnapshot<TResult> {
  return {
    operationId: record.operationId,
    kind: record.kind,
    workspaceId: record.workspaceId,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    progress: record.progress,
    diagnostics: record.diagnostics ? { ...record.diagnostics } : undefined,
    result: record.result,
    error: record.error,
  };
}

export class LongTaskOperationManager<TResult = unknown> {
  readonly #operations = new Map<string, LongTaskOperationRecord<TResult>>();

  constructor(readonly maxRetained = 100, private readonly journal?: LongTaskJournal<TResult>) {
    if (!Number.isInteger(maxRetained) || maxRetained < 1) {
      throw new Error("maxRetained must be a positive integer");
    }
  }

  start(
    kind: LongTaskKind,
    workspaceId: string,
    run: (context: LongTaskRunContext) => Promise<TResult>,
  ): LongTaskStartedOperation<TResult> {
    this.#evictCompleted();
    const operationId = `operation_${randomUUID()}`;
    const controller = new AbortController();

    let resolveCompletion!: (snapshot: LongTaskOperationSnapshot<TResult>) => void;
    const completion = new Promise<LongTaskOperationSnapshot<TResult>>((resolve) => {
      resolveCompletion = resolve;
    });

    const record: LongTaskOperationRecord<TResult> = {
      operationId,
      kind,
      workspaceId,
      status: "queued",
      createdAt: new Date().toISOString(),
      progress: `${kind} operation accepted.`,
      controller,
      resolveCompletion,
      completion,
    };
    this.journal?.save(snapshot(record));
    this.#operations.set(operationId, record);

    queueMicrotask(() => {
      void this.#execute(record, run);
    });

    const snap = snapshot(record);
    return {
      ...snap,
      completion,
    };
  }

  get(operationId: string): LongTaskOperationSnapshot<TResult> {
    const operation = this.tryGet(operationId);
    if (!operation) throw new Error(`Unknown long-task operation: ${operationId}`);
    return operation;
  }

  tryGet(operationId: string): LongTaskOperationSnapshot<TResult> | undefined {
    const record = this.#operations.get(operationId);
    return record ? snapshot(record) : this.journal?.find(operationId);
  }

  getCompletion(operationId: string): Promise<LongTaskOperationSnapshot<TResult>> {
    const record = this.#operations.get(operationId);
    if (!record) throw new Error(`Unknown long-task operation: ${operationId}`);
    return record.completion;
  }

  updateDiagnostics(
    operationId: string,
    fields: Record<string, unknown>,
  ): LongTaskOperationSnapshot<TResult> {
    const record = this.#operations.get(operationId);
    if (!record) throw new Error(`Unknown long-task operation: ${operationId}`);
    record.diagnostics = { ...record.diagnostics, ...fields };
    this.journal?.save(snapshot(record));
    return snapshot(record);
  }

  list(workspaceId?: string): LongTaskOperationSnapshot<TResult>[] {
    const result: LongTaskOperationSnapshot<TResult>[] = [];
    for (const record of this.#operations.values()) {
      if (!workspaceId || record.workspaceId === workspaceId) {
        result.push(snapshot(record));
      }
    }
    return result;
  }

  cancel(operationId: string): LongTaskOperationSnapshot<TResult> {
    const operation = this.tryCancel(operationId);
    if (!operation) throw new Error(`Unknown long-task operation: ${operationId}`);
    return operation;
  }

  tryCancel(operationId: string): LongTaskOperationSnapshot<TResult> | undefined {
    const record = this.#operations.get(operationId);
    if (!record) return this.journal?.find(operationId);
    if (isTerminal(record.status)) return snapshot(record);

    record.status = "cancelling";
    record.progress = "Cancellation requested; terminating the managed process tree.";
    this.journal?.save(snapshot(record));
    record.controller.abort(abortError());
    return snapshot(record);
  }

  async #execute(
    record: LongTaskOperationRecord<TResult>,
    run: (context: LongTaskRunContext) => Promise<TResult>,
  ): Promise<void> {
    try {
      if (record.controller.signal.aborted) throw abortError();
      const result = await run({
        signal: record.controller.signal,
        update: (status, progress) => {
          if (record.status === "cancelling" || isTerminal(record.status)) return;
          record.status = status;
          if (status === "running" && !record.startedAt) {
            record.startedAt = new Date().toISOString();
          }
          record.progress = progress;
          this.journal?.save(snapshot(record));
        },
        updateDiagnostics: (fields) => {
          record.diagnostics = { ...record.diagnostics, ...fields };
          this.journal?.save(snapshot(record));
        },
      });
      if (record.controller.signal.aborted) throw abortError();
      record.result = result;
      record.status = "succeeded";
      record.progress = `${record.kind} operation completed.`;
    } catch (error) {
      if (
        record.controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        record.status = "cancelled";
        record.progress = `${record.kind} operation cancelled.`;
      } else {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        record.progress = `${record.kind} operation failed.`;
      }
    } finally {
      record.completedAt = new Date().toISOString();
      try {
        this.journal?.save(snapshot(record));
      } catch (error) {
        record.status = "unknown";
        record.error = "durable_operation_journal_failed: " + String(error);
      } finally {
        record.resolveCompletion(snapshot(record));
      }
    }
  }

  #evictCompleted(): void {
    if (this.#operations.size < this.maxRetained) return;
    for (const [operationId, record] of this.#operations) {
      if (!isTerminal(record.status)) continue;
      this.#operations.delete(operationId);
      if (this.#operations.size < this.maxRetained) return;
    }
    if (this.#operations.size >= this.maxRetained) {
      throw new Error(
        `Long-task operation capacity reached (${this.maxRetained} active or retained operations)`,
      );
    }
  }
}

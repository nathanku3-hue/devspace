import { randomUUID } from "node:crypto";

export type LongTaskKind = "shell" | "validation";
export type LongTaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface LongTaskRunContext {
  signal: AbortSignal;
  update(status: "queued" | "running", progress: string): void;
}

export interface LongTaskOperationSnapshot<TResult> {
  operationId: string;
  kind: LongTaskKind;
  workspaceId: string;
  status: LongTaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  progress: string;
  result?: TResult;
  error?: string;
}

interface LongTaskOperationRecord<TResult>
  extends LongTaskOperationSnapshot<TResult> {
  controller: AbortController;
}

function abortError(): Error {
  const error = new Error("Long task cancelled");
  error.name = "AbortError";
  return error;
}

function isTerminal(status: LongTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
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
    result: record.result,
    error: record.error,
  };
}

export class LongTaskOperationManager<TResult> {
  readonly #operations = new Map<string, LongTaskOperationRecord<TResult>>();

  constructor(readonly maxRetained = 100) {
    if (!Number.isInteger(maxRetained) || maxRetained < 1) {
      throw new Error("maxRetained must be a positive integer");
    }
  }

  start(
    kind: LongTaskKind,
    workspaceId: string,
    run: (context: LongTaskRunContext) => Promise<TResult>,
  ): LongTaskOperationSnapshot<TResult> {
    this.#evictCompleted();
    const operationId = `operation_${randomUUID()}`;
    const record: LongTaskOperationRecord<TResult> = {
      operationId,
      kind,
      workspaceId,
      status: "queued",
      createdAt: new Date().toISOString(),
      progress: `${kind} operation accepted.`,
      controller: new AbortController(),
    };
    this.#operations.set(operationId, record);

    queueMicrotask(() => {
      void this.#execute(record, run);
    });
    return snapshot(record);
  }

  get(operationId: string): LongTaskOperationSnapshot<TResult> {
    const record = this.#operations.get(operationId);
    if (!record) throw new Error(`Unknown long-task operation: ${operationId}`);
    return snapshot(record);
  }

  cancel(operationId: string): LongTaskOperationSnapshot<TResult> {
    const record = this.#operations.get(operationId);
    if (!record) throw new Error(`Unknown long-task operation: ${operationId}`);
    if (isTerminal(record.status)) return snapshot(record);

    record.status = "cancelling";
    record.progress = "Cancellation requested; terminating the managed process tree.";
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

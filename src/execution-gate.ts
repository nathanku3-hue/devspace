export class ExecutionBusyError extends Error {
  readonly code = "EXECUTION_BUSY";

  constructor(
    readonly gate: string,
    readonly active: number,
    readonly queued: number,
    readonly queueLimit: number,
  ) {
    super(
      `${gate} is busy (${active} active, ${queued} queued; queue limit ${queueLimit})`,
    );
    this.name = "ExecutionBusyError";
  }
}

export interface ExecutionGateOptions {
  signal?: AbortSignal;
  onQueued?: (position: number) => void;
}

interface Waiter<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(): Error {
  const error = new Error("Execution cancelled");
  error.name = "AbortError";
  return error;
}

export class ExecutionGate {
  #active = 0;
  readonly #queue: Waiter<unknown>[] = [];

  constructor(
    readonly name: string,
    readonly maxConcurrent: number,
    readonly maxQueued: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("maxQueued must be a non-negative integer");
    }
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  async run<T>(task: () => Promise<T>, options: ExecutionGateOptions = {}): Promise<T> {
    if (options.signal?.aborted) throw abortError();

    if (this.#active < this.maxConcurrent) {
      return this.#start(task);
    }

    if (this.#queue.length >= this.maxQueued) {
      throw new ExecutionBusyError(
        this.name,
        this.#active,
        this.#queue.length,
        this.maxQueued,
      );
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        task,
        resolve,
        reject,
        signal: options.signal,
      };
      this.#queue.push(waiter as Waiter<unknown>);
      if (options.signal) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter as Waiter<unknown>);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(abortError());
        };
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
        if (options.signal.aborted) waiter.onAbort();
      }
      try {
        options.onQueued?.(this.#queue.length);
      } catch {
        // Queue visibility must not change execution semantics.
      }
    });
  }

  async #start<T>(task: () => Promise<T>): Promise<T> {
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#drain();
    }
  }

  #drain(): void {
    while (this.#active < this.maxConcurrent && this.#queue.length > 0) {
      const waiter = this.#queue.shift()!;
      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      void this.#start(waiter.task).then(waiter.resolve, waiter.reject);
    }
  }
}

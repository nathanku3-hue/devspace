export interface ShellExecutionLimits {
  maxActive: number;
  maxActivePerKey: number;
  maxQueued: number;
  queueTimeoutMs: number;
}

export const DEFAULT_SHELL_EXECUTION_LIMITS: ShellExecutionLimits = {
  maxActive: 2,
  maxActivePerKey: 1,
  maxQueued: 16,
  queueTimeoutMs: 60_000,
};

interface Waiter {
  key: string;
  resolve: (lease: ShellExecutionLease) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ShellExecutionLease {
  release(): void;
}

export interface ShellAcquireOptions {
  signal?: AbortSignal;
  queueTimeoutMs?: number | null;
}

export class ShellExecutionLimiter {
  private active = 0;
  private readonly activeByKey = new Map<string, number>();
  private readonly queue: Waiter[] = [];

  constructor(private readonly limits: ShellExecutionLimits = DEFAULT_SHELL_EXECUTION_LIMITS) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid shell execution limit ${name}=${String(value)}`);
      }
    }
  }

  acquire(
    key: string,
    optionsOrSignal?: AbortSignal | ShellAcquireOptions,
  ): Promise<ShellExecutionLease> {
    const normalizedKey = key || ".";
    let signal: AbortSignal | undefined;
    let queueTimeoutMs: number | null | undefined;

    if (optionsOrSignal && "aborted" in optionsOrSignal) {
      signal = optionsOrSignal;
      queueTimeoutMs = this.limits.queueTimeoutMs;
    } else if (optionsOrSignal) {
      signal = optionsOrSignal.signal;
      queueTimeoutMs = optionsOrSignal.queueTimeoutMs;
    } else {
      queueTimeoutMs = this.limits.queueTimeoutMs;
    }

    if (signal?.aborted) {
      return Promise.reject(new Error("Shell request was cancelled before execution."));
    }

    if (this.canStart(normalizedKey)) {
      return Promise.resolve(this.start(normalizedKey));
    }

    if (this.queue.length >= this.limits.maxQueued) {
      return Promise.reject(
        new Error(
          `DevSpace shell queue is full (${this.limits.maxQueued} waiting, ${this.active} active). Retry after an active shell command finishes.`,
        ),
      );
    }

    return new Promise<ShellExecutionLease>((resolve, reject) => {
      const waiter: Waiter = { key: normalizedKey, resolve, reject, signal };
      const effectiveTimeoutMs =
        queueTimeoutMs === undefined ? this.limits.queueTimeoutMs : queueTimeoutMs;

      if (effectiveTimeoutMs !== null && effectiveTimeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          if (!this.removeWaiter(waiter)) return;
          this.detachAbort(waiter);
          reject(
            new Error(
              `DevSpace shell queue wait exceeded ${effectiveTimeoutMs}ms. Retry after an active shell command finishes.`,
            ),
          );
        }, effectiveTimeoutMs);
        waiter.timeout.unref?.();
      }

      if (signal) {
        waiter.onAbort = () => {
          if (!this.removeWaiter(waiter)) return;
          if (waiter.timeout) clearTimeout(waiter.timeout);
          reject(new Error("Shell request was cancelled while waiting for an execution slot."));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      this.queue.push(waiter);
    });
  }

  snapshot(): { active: number; queued: number; activeByKey: Record<string, number> } {
    return {
      active: this.active,
      queued: this.queue.length,
      activeByKey: Object.fromEntries(this.activeByKey),
    };
  }

  private canStart(key: string): boolean {
    return (
      this.active < this.limits.maxActive &&
      (this.activeByKey.get(key) ?? 0) < this.limits.maxActivePerKey
    );
  }

  private start(key: string): ShellExecutionLease {
    this.active += 1;
    this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + 1);
    let released = false;

    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        const perKey = (this.activeByKey.get(key) ?? 1) - 1;
        if (perKey <= 0) this.activeByKey.delete(key);
        else this.activeByKey.set(key, perKey);
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.active < this.limits.maxActive) {
      const index = this.queue.findIndex((waiter) => this.canStart(waiter.key));
      if (index === -1) return;
      const [waiter] = this.queue.splice(index, 1);
      if (!waiter) return;
      if (waiter.timeout) clearTimeout(waiter.timeout);
      this.detachAbort(waiter);
      waiter.resolve(this.start(waiter.key));
    }
  }

  private removeWaiter(waiter: Waiter): boolean {
    const index = this.queue.indexOf(waiter);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    return true;
  }

  private detachAbort(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function shellExecutionLimitsFromEnv(): ShellExecutionLimits {
  return {
    maxActive: positiveIntegerEnv("DEVSPACE_SHELL_MAX_ACTIVE", DEFAULT_SHELL_EXECUTION_LIMITS.maxActive),
    maxActivePerKey: positiveIntegerEnv(
      "DEVSPACE_SHELL_MAX_ACTIVE_PER_WORKSPACE",
      DEFAULT_SHELL_EXECUTION_LIMITS.maxActivePerKey,
    ),
    maxQueued: positiveIntegerEnv("DEVSPACE_SHELL_MAX_QUEUED", DEFAULT_SHELL_EXECUTION_LIMITS.maxQueued),
    queueTimeoutMs: positiveIntegerEnv(
      "DEVSPACE_SHELL_QUEUE_TIMEOUT_MS",
      DEFAULT_SHELL_EXECUTION_LIMITS.queueTimeoutMs,
    ),
  };
}

export const globalShellExecutionLimiter = new ShellExecutionLimiter(shellExecutionLimitsFromEnv());

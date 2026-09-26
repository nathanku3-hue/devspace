import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { WorkspaceShell } from "./workspace-shell.js";

const EXIT_STDIO_GRACE_MS = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CONFIGURED_OUTPUT_BYTES = 128 * 1024 * 1024;
const trackedShellPids = new Set<number>();

function configuredOutputLimit(): number {
  const raw = process.env.DEVSPACE_SHELL_MAX_OUTPUT_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_OUTPUT_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 64 * 1024) return DEFAULT_MAX_OUTPUT_BYTES;
  return Math.min(parsed, MAX_CONFIGURED_OUTPUT_BYTES);
}

export function shellOutputLimitBytes(): number {
  return configuredOutputLimit();
}

export function createGuardedBashOperations(
  shell: WorkspaceShell,
  maxOutputBytes = configuredOutputLimit(),
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");

      const commandFromStdin = shell.kind === "wsl-bash";
      const child = spawn(
        shell.shellPath,
        commandFromStdin ? ["-s"] : ["-c", command],
        {
          cwd,
          detached: process.platform !== "win32",
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      ) as ChildProcessWithoutNullStreams;

      if (commandFromStdin) {
        child.stdin.on("error", () => undefined);
        child.stdin.end(command);
      } else {
        child.stdin.end();
      }

      if (child.pid) trackedShellPids.add(child.pid);

      let timedOut = false;
      let outputExceeded = false;
      let forwardedBytes = 0;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const terminate = () => {
        if (child.pid) killProcessTree(child.pid);
      };
      const onAbort = () => terminate();
      const forward = (chunk: Buffer) => {
        if (outputExceeded) return;
        const remaining = maxOutputBytes - forwardedBytes;
        if (remaining <= 0) {
          outputExceeded = true;
          terminate();
          return;
        }

        if (chunk.length <= remaining) {
          forwardedBytes += chunk.length;
          onData(chunk);
          return;
        }

        if (remaining > 0) {
          forwardedBytes += remaining;
          onData(chunk.subarray(0, remaining));
        }
        outputExceeded = true;
        terminate();
      };

      try {
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            terminate();
          }, timeout * 1000);
          timeoutHandle.unref?.();
        }

        child.stdout.on("data", forward);
        child.stderr.on("data", forward);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) throw new Error("aborted");
        if (outputExceeded) {
          throw new Error(
            `Command exceeded the DevSpace output safety limit of ${formatBytes(maxOutputBytes)} and was terminated.`,
          );
        }
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        child.stdout.off("data", forward);
        child.stderr.off("data", forward);
        if (child.pid) trackedShellPids.delete(child.pid);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export function killTrackedShellProcesses(): void {
  const pids = [...trackedShellPids];
  trackedShellPids.clear();
  for (const pid of pids) killProcessTree(pid, true);
}

function killProcessTree(pid: number, synchronous = false): void {
  if (process.platform === "win32") {
    try {
      if (synchronous) {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 10_000,
        });
      } else {
        const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        });
        killer.unref();
      }
    } catch {
      // The process may already be gone.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already be gone.
    }
  }
}

function waitForChildProcess(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let idleTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = false;
    let stderrEnded = false;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.stdout.off("end", onStdoutEnd);
      child.stderr.off("end", onStderrEnd);
      child.stdout.off("data", onPostExitData);
      child.stderr.off("data", onPostExitData);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(code);
    };
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(exitCode), EXIT_STDIO_GRACE_MS);
      idleTimer.unref?.();
    };
    const maybeFinish = () => {
      if (exited && stdoutEnded && stderrEnded) finish(exitCode);
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinish();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinish();
    };
    const onPostExitData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinish();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => finish(code);

    child.stdout.once("end", onStdoutEnd);
    child.stderr.once("end", onStderrEnd);
    child.stdout.on("data", onPostExitData);
    child.stderr.on("data", onPostExitData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

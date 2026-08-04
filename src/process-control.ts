import { spawn } from "node:child_process";

function waitForExit(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${executable} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function processMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH",
  );
}

export async function terminateProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (platform === "win32") {
    const code = await waitForExit(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      10_000,
    );
    // taskkill returns 128 when the target exited before it was inspected.
    if (code !== 0 && code !== 128) {
      throw new Error(`taskkill failed for PID ${pid} with exit code ${code}`);
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!processMissing(error)) throw error;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!processMissing(error)) throw error;
  }
}

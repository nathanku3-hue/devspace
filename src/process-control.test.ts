import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminateProcessTree } from "./process-control.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for process-tree fixture");
}

const root = await mkdtemp(join(tmpdir(), "devspace-process-tree-"));
const childPidPath = join(root, "child.pid");
const parentScript = [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });",
  "writeFileSync(process.argv[1], String(child.pid));",
  "setInterval(() => {}, 1000);",
].join("\n");

const parent = spawn(process.execPath, ["-e", parentScript, childPidPath], {
  detached: process.platform !== "win32",
  windowsHide: true,
  stdio: "ignore",
});

try {
  assert.ok(parent.pid);
  const childPid = await waitFor(async () => {
    try {
      const value = Number((await readFile(childPidPath, "utf8")).trim());
      return Number.isInteger(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  });
  assert.equal(isAlive(parent.pid), true);
  assert.equal(isAlive(childPid), true);

  await terminateProcessTree(parent.pid);
  await waitFor(async () =>
    !isAlive(parent.pid!) && !isAlive(childPid) ? true : undefined,
  );
  assert.equal(isAlive(parent.pid), false);
  assert.equal(isAlive(childPid), false);
} finally {
  if (parent.pid && isAlive(parent.pid)) {
    await terminateProcessTree(parent.pid).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
}

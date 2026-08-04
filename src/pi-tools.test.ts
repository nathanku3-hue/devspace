import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "./pi-tools.js";

const root = await mkdtemp(join(tmpdir(), "devspace-shell-cancel-"));
const controller = new AbortController();
const startedAt = Date.now();
const execution = runShellTool(
  {
    command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
    timeout: 3,
  },
  { cwd: root, root },
  { signal: controller.signal },
);

try {
  setTimeout(() => controller.abort(), 200);
  const result = await execution;
  assert.equal(result.isError, true);
  assert.match(
    result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n"),
    /Command aborted/,
  );
  assert.ok(Date.now() - startedAt < 2500, "shell ignored the MCP abort signal");
} finally {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

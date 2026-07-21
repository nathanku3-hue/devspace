import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  MAX_BATCH_READ_FILES,
  readWorkspaceFiles,
} from "./read-files.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-read-files-test-"));

try {
  const agentDir = join(root, ".agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(root, "first.md"), "alpha\nbeta\ngamma\n");
  await writeFile(join(root, "second.md"), "delta\nepsilon\n");
  await writeFile(join(root, "large.md"), "x".repeat(1_000));

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace } = await registry.openWorkspace(root);

  const result = await readWorkspaceFiles(registry, workspace, [
    { path: "first.md", offset: 2, limit: 1 },
    { path: "missing.md" },
    { path: "second.md" },
  ]);

  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.files.map((file) => file.status),
    ["ok", "error", "ok"],
  );
  assert.match(result.text, /===== FILE: first\.md =====/);
  assert.match(result.text, /beta/);
  assert.match(result.text, /===== FILE: missing\.md =====/);
  assert.match(result.text, /\[ERROR\]/);
  assert.match(result.text, /===== FILE: second\.md =====/);
  assert.ok(
    result.text.indexOf("first.md") < result.text.indexOf("missing.md") &&
      result.text.indexOf("missing.md") < result.text.indexOf("second.md"),
  );

  const capped = await readWorkspaceFiles(
    registry,
    workspace,
    [{ path: "large.md" }, { path: "second.md" }],
    { maxCharacters: 120 },
  );
  assert.equal(capped.truncated, true);
  assert.equal(capped.characters, 120);
  assert.equal(capped.files[0].status, "ok");
  assert.equal(capped.files[0].truncated, true);
  assert.equal(capped.files[1].status, "skipped");
  assert.match(capped.text, /TRUNCATED/);

  await assert.rejects(
    () =>
      readWorkspaceFiles(
        registry,
        workspace,
        Array.from({ length: MAX_BATCH_READ_FILES + 1 }, (_, index) => ({
          path: `file-${index}.md`,
        })),
      ),
    /at most 20 files/,
  );

  await assert.rejects(
    () =>
      readWorkspaceFiles(registry, workspace, [
        { path: "first.md", limit: 2_001 },
      ]),
    /limit must be between 1 and 2000/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

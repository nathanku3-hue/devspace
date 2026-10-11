import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";
import { assertNativeWritePath, assertWritableRepository } from "./write-scope.js";
import { readFileTool } from "./pi-tools.js";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry } from "./workspaces.js";

const outer = await mkdtemp(join(tmpdir(), "devspace-write-scope-"));
const repo = join(outer, "repo");
try {
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "DevSpace Test"]);
  await git(repo, ["config", "user.email", "devspace-test@example.invalid"]);
  await writeFile(join(repo, "README.md"), "baseline\n");
  await git(repo, ["add", "--", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await mkdir(join(repo, "nested"));

  const writable = await assertWritableRepository(repo);
  assert.equal(writable.headSha.length, 40);
  await assert.rejects(() => assertWritableRepository(outer), /READ_ONLY_DISCOVERY/);
  await assert.rejects(() => assertWritableRepository(join(repo, "nested")), /READ_ONLY_DISCOVERY/);
  await assertNativeWritePath(repo, join(repo, "nested", "new-file.ts"));
  await assert.rejects(
    () => assertNativeWritePath(repo, join(outer, "sibling.txt")),
    /WRITE_SCOPE_ESCAPE/,
  );
  await assert.rejects(
    () => assertNativeWritePath(repo, join(repo, ".git", "config")),
    /WRITE_SCOPE_PROTECTED/,
  );

  const external = join(outer, "external");
  await mkdir(external);
  await writeFile(join(external, "secret.txt"), "outside root\n");
  await symlink(external, join(repo, "escape"), platform() === "win32" ? "junction" : "dir");
  await assert.rejects(
    () => assertNativeWritePath(repo, join(repo, "escape", "leaked.txt")),
    /WRITE_SCOPE_ESCAPE/,
  );
  await assert.rejects(
    () => readFileTool({ path: join(repo, "escape", "secret.txt") }, { cwd: repo, root: repo }),
    /READ_SCOPE_ESCAPE/,
  );
  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: repo,
    DEVSPACE_OAUTH_OWNER_TOKEN: "devspace-root-escape-test-owner",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  await assert.rejects(
    () => registry.openWorkspace(join(repo, "escape")),
    /WORKSPACE_ROOT_ESCAPE/,
  );
} finally {
  await rm(outer, { recursive: true, force: true });
}

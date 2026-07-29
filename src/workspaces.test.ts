import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { publishGitChanges } from "./git-publish.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
const legacyGlobalRoot = await mkdtemp(join(tmpdir(), "devspace-legacy-worktree-root-test-"));

try {
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: legacyGlobalRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace, agentsFiles, availableAgentsFiles } = await registry.openWorkspace(root);

  assert.equal(workspace.mode, "checkout");
  assert.deepEqual(
    agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.deepEqual(
    availableAgentsFiles.map((file) => file.path),
    [join(root, "nested", "AGENTS.md")],
  );

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  const missingWorkspace = await registry.openWorkspace(missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.root, missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.mode, "checkout");
  assert.equal((await stat(missingWorkspaceRoot)).isDirectory(), true);

  await assert.rejects(
    () => registry.openWorkspace({ path: root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = join(root, "git-project");
  await createTestRepository(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await writeFile(join(gitRoot, ".gitignore"), "tmp/\n");
  await mkdir(join(gitRoot, "tracked", "nested"), { recursive: true });
  await writeFile(join(gitRoot, "tracked", "nested", "AGENTS.md"), "tracked nested instructions\n");
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  await git(gitRoot, ["branch", "existing-worktree-branch"]);
  await mkdir(join(gitRoot, "untracked", "active"), { recursive: true });
  await writeFile(join(gitRoot, "untracked", "active", "AGENTS.md"), "untracked active instructions\n");
  await mkdir(join(gitRoot, "tmp", "replay"), { recursive: true });
  await writeFile(join(gitRoot, "tmp", "replay", "AGENTS.md"), "ignored replay instructions\n");
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const gitCheckoutWorkspace = await registry.openWorkspace(gitRoot);
  assert.throws(
    () => registry.resolvePath(gitCheckoutWorkspace.workspace, "../AGENTS.md"),
    /outside allowed roots|outside workspace root/,
  );
  assert.deepEqual(
    gitCheckoutWorkspace.availableAgentsFiles.map((file) => file.path),
    [
      join(gitRoot, "tracked", "nested", "AGENTS.md"),
      join(gitRoot, "untracked", "active", "AGENTS.md"),
    ],
  );

  await assert.rejects(
    () => registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_WORKTREE_ROOT_NOT_IGNORED",
  );
  await writeFile(join(gitRoot, ".git", "info", "exclude"), "/.worktrees/\n");

  const worktreeWorkspace = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  const managedRoot = join(await realpath(gitRoot), ".worktrees");
  assert.equal(worktreeWorkspace.workspace.mode, "worktree");
  assert.equal(worktreeWorkspace.workspace.root.startsWith(managedRoot), true);
  assert.match(worktreeWorkspace.workspace.root, /[\\/]\.worktrees[\\/]devspace-[a-f0-9]{16}$/);
  assert.equal(worktreeWorkspace.workspace.sourceRoot, await realpath(gitRoot));
  assert.equal(worktreeWorkspace.workspace.worktree?.baseRef, "HEAD");
  assert.equal(worktreeWorkspace.workspace.worktree?.branch, undefined);
  assert.equal(worktreeWorkspace.workspace.worktree?.dirtySource, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.detached, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.managed, true);
  assert.equal((await stat(worktreeWorkspace.workspace.root)).isDirectory(), true);
  assert.equal((await listDirectoryNames(legacyGlobalRoot)).length, 0);
  assert.equal((await git(gitRoot, ["status", "--porcelain=v1"])).includes(".worktrees"), false);

  const closedDetached = await registry.closeWorkspace({ workspaceId: worktreeWorkspace.workspace.id });
  assert.equal(closedDetached.removed, true);
  assert.equal(await exists(worktreeWorkspace.workspace.root), false);
  assert.equal((await git(gitRoot, ["worktree", "list", "--porcelain"])).includes(worktreeWorkspace.workspace.root), false);

  await assert.rejects(
    () => registry.openWorkspace({ path: gitRoot, mode: "worktree", createBranch: true }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_INVALID_WORKTREE_OPTIONS",
  );

  const attachedWorktree = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
    branch: "existing-worktree-branch",
  });
  assert.equal(attachedWorktree.workspace.worktree?.branch, "existing-worktree-branch");
  assert.equal(attachedWorktree.workspace.worktree?.detached, false);
  assert.equal(
    await git(attachedWorktree.workspace.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    "existing-worktree-branch",
  );

  const nestedFromLinkedWorktree = await registry.openWorkspace({
    path: attachedWorktree.workspace.root,
    mode: "worktree",
  });
  assert.equal(nestedFromLinkedWorktree.workspace.sourceRoot, await realpath(gitRoot));
  assert.equal(nestedFromLinkedWorktree.workspace.root.startsWith(managedRoot), true);
  await registry.closeWorkspace({ workspaceId: nestedFromLinkedWorktree.workspace.id });

  const createdWorktree = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
    baseRef: "HEAD",
    branch: "created-worktree-branch",
    createBranch: true,
  });
  assert.equal(createdWorktree.workspace.worktree?.branch, "created-worktree-branch");
  assert.equal(createdWorktree.workspace.worktree?.detached, false);
  await writeFile(join(createdWorktree.workspace.root, "managed-change.txt"), "managed worktree\n");
  const published = await publishGitChanges({
    cwd: createdWorktree.workspace.root,
    workspaceRoot: createdWorktree.workspace.root,
    allowedRoots: [createdWorktree.workspace.root],
    paths: ["managed-change.txt"],
    message: "Test managed worktree publication",
    push: false,
  });
  assert.equal(published.branch, "created-worktree-branch");
  assert.equal((await registry.closeWorkspace({ workspaceId: createdWorktree.workspace.id })).removed, true);

  const dirtyWorktree = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  await writeFile(join(dirtyWorktree.workspace.root, "dirty-managed.txt"), "dirty\n");
  await assert.rejects(
    () => registry.closeWorkspace({ workspaceId: dirtyWorktree.workspace.id }),
    (error: unknown) => error instanceof GitWorktreeError && error.code === "GIT_WORKTREE_DIRTY",
  );
  assert.equal(await exists(dirtyWorktree.workspace.root), true);
  await rm(join(dirtyWorktree.workspace.root, "dirty-managed.txt"));
  await registry.closeWorkspace({ workspaceId: dirtyWorktree.workspace.id });

  const ignoredWorktree = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  await mkdir(join(ignoredWorktree.workspace.root, "tmp"), { recursive: true });
  await writeFile(join(ignoredWorktree.workspace.root, "tmp", "ignored-custody.txt"), "ignored custody\n");
  await assert.rejects(
    () => registry.closeWorkspace({ workspaceId: ignoredWorktree.workspace.id }),
    (error: unknown) => error instanceof GitWorktreeError && error.code === "GIT_WORKTREE_DIRTY",
  );
  assert.equal(await exists(ignoredWorktree.workspace.root), true);
  await rm(join(ignoredWorktree.workspace.root, "tmp"), { recursive: true, force: true });
  await registry.closeWorkspace({ workspaceId: ignoredWorktree.workspace.id });

  const concurrent = await Promise.all([
    registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
    registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
  ]);
  assert.notEqual(concurrent[0].workspace.root, concurrent[1].workspace.root);
  await Promise.all(concurrent.map(({ workspace: item }) => registry.closeWorkspace({ workspaceId: item.id })));

  const staleWorktree = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  await rm(staleWorktree.workspace.root, { recursive: true, force: true });
  await assert.rejects(
    () => registry.closeWorkspace({ workspaceId: staleWorktree.workspace.id }),
    (error: unknown) =>
      error instanceof GitWorktreeError &&
      error.code === "GIT_WORKTREE_STALE_METADATA_REQUIRES_CONFIRMATION",
  );
  const pruned = await registry.closeWorkspace({
    workspaceId: staleWorktree.workspace.id,
    pruneStaleMetadata: true,
  });
  assert.equal(pruned.staleMetadataPruned, true);

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(root);
  const persistentWorktree = await persistentRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
    branch: "persistent-worktree-branch",
    createBranch: true,
  });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  assert.equal(restoredRegistry.getWorkspace(persistentWorkspace.workspace.id).mode, "checkout");
  const restoredWorktree = restoredRegistry.getWorkspace(persistentWorktree.workspace.id);
  assert.equal(restoredWorktree.sourceRoot, await realpath(gitRoot));
  assert.equal(restoredWorktree.worktree?.branch, "persistent-worktree-branch");
  await restoredRegistry.closeWorkspace({ workspaceId: persistentWorktree.workspace.id });
  assert.throws(
    () => restoredRegistry.getWorkspace(persistentWorktree.workspace.id),
    /Unknown or closed workspaceId/,
  );
  secondStore.close();

  await registry.closeWorkspace({ workspaceId: attachedWorktree.workspace.id });

  const escapeRoot = join(root, "escape-project");
  await createTestRepository(escapeRoot);
  await writeFile(join(escapeRoot, "README.md"), "escape\n");
  await git(escapeRoot, ["add", "."]);
  await git(escapeRoot, ["commit", "-m", "Initial escape commit"]);
  await writeFile(join(escapeRoot, ".git", "info", "exclude"), "/.worktrees/\n");
  const externalRoot = join(root, "external-worktrees");
  await mkdir(externalRoot);
  await symlink(externalRoot, join(escapeRoot, ".worktrees"), platform() === "win32" ? "junction" : "dir");
  await assert.rejects(
    () => registry.openWorkspace({ path: escapeRoot, mode: "worktree" }),
    (error: unknown) => error instanceof GitWorktreeError && error.code === "GIT_WORKTREE_ROOT_ESCAPE",
  );

  if (platform() !== "win32") {
    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");
    const aliasConfig = loadConfig({
      DEVSPACE_ALLOWED_ROOTS: aliasRoot,
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasRegistry = new WorkspaceRegistry(aliasConfig);
    const aliasWorkspace = await aliasRegistry.openWorkspace({
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    });
    assert.equal(aliasWorkspace.workspace.sourceRoot, await realpath(gitRoot));
    await aliasRegistry.closeWorkspace({ workspaceId: aliasWorkspace.workspace.id });
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(legacyGlobalRoot, { recursive: true, force: true });
}

async function createTestRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ["init"]);
  await git(path, ["config", "user.email", "devspace@example.com"]);
  await git(path, ["config", "user.name", "DevSpace Test"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirectoryNames(path: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}

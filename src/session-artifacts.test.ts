import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const outer = await mkdtemp(join(tmpdir(), "devspace-session-close-"));
const root = join(outer, "repo");
const storePath = join(outer, "state");
await mkdir(root);
const config = loadConfig({
  DEVSPACE_ALLOWED_ROOTS: outer,
  DEVSPACE_OAUTH_OWNER_TOKEN: "session-close-testing-owner-token",
  PORT: "1",
});
const store = new SqliteWorkspaceStore(storePath);
const registry = new WorkspaceRegistry(config, store);

async function head(): Promise<string> {
  return (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
}
async function status(): Promise<string> {
  return (await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
}
async function mutate(id: string, file: string, content: string, repo = root): Promise<void> {
  await registry.withTrackedMutation(id, [file], () => writeFile(join(repo, file), content));
}
async function anotherRepo(name: string): Promise<string> {
  const location = join(outer, name);
  await mkdir(location);
  await git(location, ["init", "-b", "main"]);
  await git(location, ["config", "user.name", "DevSpace Test"]);
  await git(location, ["config", "user.email", "devspace-test@example.invalid"]);
  await writeFile(join(location, "old.md"), "clean baseline\n");
  await git(location, ["add", "--", "old.md"]);
  await git(location, ["commit", "-m", "initial"]);
  return location;
}

try {
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await git(root, ["config", "user.email", "devspace-test@example.invalid"]);
  await writeFile(join(root, "old.md"), "old\n");
  await writeFile(join(root, "foreign.md"), "original\n");
  await git(root, ["add", "--", "old.md", "foreign.md"]);
  await git(root, ["commit", "-m", "baseline"]);

  // Existing unrelated staged bytes are never swept into the session commit.
  await writeFile(join(root, "foreign.md"), "other staged session\n");
  await git(root, ["add", "--", "foreign.md"]);
  const originalForeignIndex = (await git(root, ["ls-files", "--stage", "--", "foreign.md"])).stdout;

  const session = (await registry.openWorkspace(root)).workspace.id;
  await mutate(session, "sprint1.md", "sprint one\n");
  await mutate(session, "sprint2.md", "sprint two\n");
  await mutate(session, "old.md", "revised by session\n");
  await mkdir(join(root, ".scratch"));
  await mutate(session, ".scratch/diagnostic.json", "{\"scratch\":true}\n");

  const closed = await registry.closeWorkspace({ workspaceId: session });
  assert.equal(closed.artifactCoverage?.status, "COVERED");
  assert.deepEqual(
    closed.artifactCoverage?.coveredPaths.sort(),
    ["old.md", "sprint1.md", "sprint2.md"],
  );
  assert.deepEqual(closed.artifactCoverage?.excludedPaths, [".scratch/diagnostic.json"]);
  assert.equal(closed.artifactCoverage?.commits.length, 1);
  assert.equal((await git(root, ["show", "HEAD:sprint1.md"])).stdout, "sprint one\n");
  assert.equal((await git(root, ["show", "HEAD:sprint2.md"])).stdout, "sprint two\n");
  assert.equal((await git(root, ["show", "HEAD:old.md"])).stdout, "revised by session\n");
  assert.equal((await git(root, ["show", "HEAD:foreign.md"])).stdout, "original\n");
  assert.equal((await git(root, ["ls-files", "--stage", "--", "foreign.md"])).stdout, originalForeignIndex);
  assert.match(await status(), /M  foreign\.md/);
  assert.match(await status(), /\?\? \.scratch\/diagnostic\.json/);

  const already = (await registry.openWorkspace(root)).workspace.id;
  await mutate(already, "previously-committed.md", "committed elsewhere\n");
  await git(root, ["add", "--", "previously-committed.md"]);
  // This is a test fixture for explicit earlier publication; preserve the unrelated index.
  await git(root, ["commit", "-m", "manual prior commit", "--", "previously-committed.md"]);
  const beforeNoop = await head();
  const noop = await registry.closeWorkspace({ workspaceId: already });
  assert.deepEqual(noop.artifactCoverage?.commits, []);
  assert.deepEqual(noop.artifactCoverage?.coveredPaths, ["previously-committed.md"]);
  assert.equal(await head(), beforeNoop);

  // Moves account for both the removed tracked source and the newly created destination.
  await writeFile(join(root, "move-src.md"), "move me\n");
  await git(root, ["add", "--", "move-src.md"]);
  await git(root, ["commit", "-m", "source for rename", "--", "move-src.md"]);
  const moved = (await registry.openWorkspace(root)).workspace.id;
  await registry.withTrackedMutation(moved, ["move-src.md", "move-dst.md"], async () => {
    await rename(join(root, "move-src.md"), join(root, "move-dst.md"));
  });
  const moveClosed = await registry.closeWorkspace({ workspaceId: moved });
  assert.deepEqual(moveClosed.artifactCoverage?.coveredPaths.sort(), ["move-dst.md", "move-src.md"]);
  assert.equal((await git(root, ["show", "HEAD:move-dst.md"])).stdout, "move me\n");
  await assert.rejects(() => git(root, ["show", "HEAD:move-src.md"]));

  const unsafeRepo = await anotherRepo("unsafe");
  const unsafe = (await registry.openWorkspace(unsafeRepo)).workspace.id;
  await mutate(unsafe, "altered.md", "authored\n", unsafeRepo);
  await writeFile(join(unsafeRepo, "altered.md"), "changed externally\n");
  const beforeUnsafe = (await git(unsafeRepo, ["rev-parse", "HEAD"])).stdout.trim();
  await assert.rejects(
    () => registry.closeWorkspace({ workspaceId: unsafe }),
    /CLOSE_INCOMPLETE: session artifact modified after recording/,
  );
  assert.equal((await git(unsafeRepo, ["rev-parse", "HEAD"])).stdout.trim(), beforeUnsafe);
  assert.equal((await readFile(join(unsafeRepo, "altered.md"), "utf8")), "changed externally\n");
  await writeFile(join(unsafeRepo, "altered.md"), "authored\n");
  const retried = await registry.closeWorkspace({ workspaceId: unsafe });
  assert.deepEqual(retried.artifactCoverage?.coveredPaths, ["altered.md"]);

  // An in-place existing dirty path cannot be wholly attributed to the session.
  const dirtyRepo = await anotherRepo("dirty");
  await writeFile(join(dirtyRepo, "old.md"), "other user's dirty text\n");
  const dirty = (await registry.openWorkspace(dirtyRepo)).workspace.id;
  await mutate(dirty, "old.md", "overwritten after foreign dirt\n", dirtyRepo);
  await assert.rejects(
    () => registry.closeWorkspace({ workspaceId: dirty }),
    /CLOSE_INCOMPLETE: unverified session paths: old.md/,
  );

  // A persisted pending write after a crash must not be incorrectly declared covered.
  const pendingRepo = await anotherRepo("pending");
  const pending = (await registry.openWorkspace(pendingRepo)).workspace.id;
  store.putArtifact({
    workspaceSessionId: pending, repositoryRoot: pendingRepo, path: "possibly-written.md",
    expectedSha256: null, state: "pending", reason: null,
  });
  await assert.rejects(
    () => registry.closeWorkspace({ workspaceId: pending }),
    /CLOSE_INCOMPLETE: unverified session paths/,
  );

  const recoveryRepo = await anotherRepo("recovery");
  const recovering = (await registry.openWorkspace(recoveryRepo)).workspace.id;
  await mutate(recovering, "survives-restart.md", "durable ledger\n", recoveryRepo);
  const restoredStore = new SqliteWorkspaceStore(storePath);
  const restoredRegistry = new WorkspaceRegistry(config, restoredStore);
  const recovered = await restoredRegistry.closeWorkspace({ workspaceId: recovering });
  assert.deepEqual(recovered.artifactCoverage?.coveredPaths, ["survives-restart.md"]);
  assert.equal((await git(recoveryRepo, ["show", "HEAD:survives-restart.md"])).stdout, "durable ledger\n");
  restoredStore.close();

  const unknownRepo = await anotherRepo("unattributed");
  const unknown = (await registry.openWorkspace(unknownRepo)).workspace.id;
  await writeFile(join(unknownRepo, "generated-by-shell.md"), "not in ledger\n");
  await assert.rejects(
    () => registry.closeWorkspace({ workspaceId: unknown }),
    /CLOSE_INCOMPLETE: unattributed documents changed since session open: generated-by-shell.md/,
  );

  const existingRepo = await anotherRepo("existing-dirty");
  await writeFile(join(existingRepo, "old.md"), "prior dirty docs\n");
  const existing = (await registry.openWorkspace(existingRepo)).workspace.id;
  const existingClosed = await registry.closeWorkspace({ workspaceId: existing });
  assert.equal(existingClosed.artifactCoverage?.status, "NO_RECORDED_WRITES");
  assert.equal((await readFile(join(existingRepo, "old.md"), "utf8")), "prior dirty docs\n");

  const emptyRepo = await anotherRepo("empty");
  const empty = (await registry.openWorkspace(emptyRepo)).workspace.id;
  const emptyClosed = await registry.closeWorkspace({ workspaceId: empty });
  assert.equal(emptyClosed.artifactCoverage?.status, "NO_RECORDED_WRITES");
} finally {
  store.close();
  await rm(outer, { recursive: true, force: true });
}

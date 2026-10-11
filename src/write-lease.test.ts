import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const dir = await mkdtemp(join(tmpdir(), "devspace-write-lease-"));
const repo = join(dir, "repo");
const storeDir = join(dir, "state");
try {
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "DevSpace Test"]);
  await git(repo, ["config", "user.email", "devspace-test@example.invalid"]);
  await writeFile(join(repo, "README.md"), "initial\n");
  await git(repo, ["add", "--", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: dir, DEVSPACE_OAUTH_OWNER_TOKEN: "devspace-lease-fixture-owner", PORT: "1",
  });
  const storeA = new SqliteWorkspaceStore(storeDir);
  const storeB = new SqliteWorkspaceStore(storeDir);
  const a = new WorkspaceRegistry(config, storeA);
  const b = new WorkspaceRegistry(config, storeB);
  const first = (await a.openWorkspace(repo)).workspace.id;
  const second = (await b.openWorkspace(repo)).workspace.id;
  assert.notEqual(first, second);

  await a.withTrackedMutation(first, ["first.ts"], () => writeFile(join(repo, "first.ts"), "first\n"));
  await assert.rejects(
    () => b.withTrackedMutation(second, ["second.ts"], () => writeFile(join(repo, "second.ts"), "second\n")),
    /WRITE_LEASE_CONFLICT/,
  );
  const firstClose = await a.closeWorkspace({ workspaceId: first });
  assert.equal(firstClose.closure, "COMMITTED_AND_CLOSED");
  assert.equal(firstClose.custodyReceipt.authority, "PHYSICAL_CUSTODY_ONLY");
  assert.equal(firstClose.artifactCoverage?.proof[0]?.path, "first.ts");
  assert.equal(firstClose.custodyReceipt.finalHeadSha, (await git(repo, ["rev-parse", "HEAD"])).stdout.trim());
  assert.equal((await readFile(join(repo, "first.ts"), "utf8")), "first\n");

  await assert.rejects(
    () => b.withTrackedMutation(second, ["second.ts"], () => writeFile(join(repo, "second.ts"), "second\n")),
    /WRITE_BASELINE_STALE/,
  );
  const detached = await b.detachWorkspace({ workspaceId: second });
  assert.equal(detached.closure, "DETACHED_WITH_UNRESOLVED_ARTIFACTS");
  storeA.close();
  storeB.close();
} finally {
  // Windows may briefly retain SQLite WAL handles after close(). Retry only
  // transient filesystem cleanup instead of masking a persistent lock.
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

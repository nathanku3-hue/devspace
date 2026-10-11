import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { relative, sep } from "node:path";
import { getGitEligibility, git } from "./git.js";
import { publishGitChanges } from "./git-publish.js";
import { isPathInsideRoot } from "./roots.js";
import type { SessionArtifact, WorkspaceStore } from "./workspace-store.js";

const EXCLUDED_SEGMENTS = new Set([".git", ".scratch", "node_modules"]);
const PROTECTED_NAMES = new Set(["PRODUCT.md", "AGENTS.md"]);
function repoPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

function excluded(path: string): boolean {
  const parts = path.split("/");
  return parts.some((part) => EXCLUDED_SEGMENTS.has(part.toLowerCase()))
    || [...PROTECTED_NAMES].some((name) => name.toLowerCase() === (parts.at(-1) ?? "").toLowerCase());
}

async function contentHash(absolutePath: string): Promise<string | null> {
  try {
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) digest.update(chunk);
    return digest.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function snapshotContentHash(path: string): Promise<string | null> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      return "symlink:" + createHash("sha256").update(target).digest("hex");
    }
    if (!metadata.isFile()) return "nonregular:" + metadata.mode.toString(8);
    return await contentHash(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function headBlob(root: string, path: string): Promise<string | null> {
  try {
    return (await git(root, ["rev-parse", "--verify", "HEAD:" + path])).stdout.trim();
  } catch {
    return null;
  }
}

async function workingBlob(root: string, path: string): Promise<string | null> {
  try {
    return (await git(root, ["hash-object", "--path=" + path, "--", path])).stdout.trim();
  } catch (error) {
    const hash = await contentHash(root + sep + path.split("/").join(sep));
    if (hash === null) return null;
    throw error;
  }
}

async function gitDirtySnapshot(root: string, workspaceRoot: string): Promise<Record<string, string>> {
  const porcelain = (await git(root, [
    "status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=all",
  ])).stdout;
  const snapshot: Record<string, string> = {};
  for (const line of porcelain.split("\0").filter(Boolean)) {
    const path = line.slice(3);
    // Protected tracked files MUST be visible to the audit even when they
    // are forbidden for automatic publication. Only disposable directories
    // are omitted from this comparison.
    if (path.split("/").some((part) => EXCLUDED_SEGMENTS.has(part.toLowerCase()))
        || !isPathInsideRoot(root + sep + path.split("/").join(sep), workspaceRoot)) continue;
    const hash = await snapshotContentHash(root + sep + path.split("/").join(sep));
    snapshot[path] = line.slice(0, 2) + ":" + (hash ?? "deleted");
  }
  return snapshot;
}

export async function captureSessionBaseline(
  store: WorkspaceStore,
  workspaceId: string,
  workspaceRoot: string,
): Promise<void> {
  const eligibility = await getGitEligibility(workspaceRoot);
  const gitRoot = eligibility.gitRoot;
  if (!eligibility.ok || !gitRoot || !isPathInsideRoot(gitRoot, workspaceRoot)) {
    store.putBaseline(workspaceId, null, {});
    return;
  }
  store.putBaseline(workspaceId, gitRoot, await gitDirtySnapshot(gitRoot, workspaceRoot));
}

async function assertNoUnattributedChanges(
  store: WorkspaceStore,
  workspaceId: string,
  workspaceRoot: string,
  artifacts: SessionArtifact[],
): Promise<void> {
  const baseline = store.getBaseline(workspaceId);
  if (!baseline) throw new Error("CLOSE_INCOMPLETE: missing durable session Git baseline");
  if (!baseline.repositoryRoot) return;
  const current = await gitDirtySnapshot(baseline.repositoryRoot, workspaceRoot);
  const owned = new Set(artifacts.map((item) => item.repositoryRoot + "\0" + item.path));
  const changed = [...new Set([...Object.keys(baseline.snapshot), ...Object.keys(current)])]
    .filter((path) => baseline.snapshot[path] !== current[path]
      && !owned.has(baseline.repositoryRoot + "\0" + path));
  if (changed.length) {
    throw new Error("CLOSE_INCOMPLETE: unattributed files changed since session open: " +
      changed.join(", "));
  }
}

export async function prepareArtifact(
  store: WorkspaceStore,
  workspaceId: string,
  workspaceRoot: string,
  absolutePath: string,
): Promise<SessionArtifact> {
  const eligibility = await getGitEligibility(workspaceRoot);
  const root = eligibility.gitRoot ?? workspaceRoot;
  const path = repoPath(root, absolutePath);
  const previous = store.getArtifact(workspaceId, root, path);
  const artifact: SessionArtifact = {
    workspaceSessionId: workspaceId,
    repositoryRoot: root,
    path,
    expectedSha256: null,
    state: "pending",
    reason: null,
  };

  if (!eligibility.ok || !isPathInsideRoot(root, workspaceRoot)) {
    artifact.state = "unsafe";
    artifact.reason = eligibility.message ?? "repository root is outside workspace";
  } else if (PROTECTED_NAMES.has((path.split("/").at(-1) ?? "").toUpperCase())) {
    artifact.state = "unsafe";
    artifact.reason = "protected path requires separate explicit custody";
  } else if (excluded(path)) {
    artifact.state = "excluded";
    artifact.reason = "disposable path";
  } else {
    try {
      await git(root, ["check-ignore", "-q", "--", path]);
      artifact.state = "excluded";
      artifact.reason = "Git-ignored artifact";
    } catch {
      // Git check-ignore exits nonzero for ordinary eligible paths.
    }
    if (artifact.state === "pending" && previous) {
      if (previous.state === "unsafe" || previous.state === "excluded") {
        artifact.state = previous.state;
        artifact.reason = previous.reason;
      } else if (previous.state !== "ready"
        || (await contentHash(absolutePath)) !== previous.expectedSha256) {
        artifact.state = "unsafe";
        artifact.reason = "unattributed mutation since previous recorded write";
      }
    } else if (artifact.state === "pending") {
      const status = (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", path])).stdout;
      if (status) {
        artifact.state = "unsafe";
        artifact.reason = "path was dirty before the first session write";
      }
    }
  }
  // Never mutate a protected, previously dirty or unattributed path.
  // A denied write was not performed, so do not poison the session ledger
  // with an unsafe entry for work that never happened.
  if (artifact.state === "unsafe") {
    throw new Error("WRITE_NOT_AUTHORIZED: " + path + " (" + (artifact.reason ?? "unsafe") + ")");
  }
  // Persist intent BEFORE touching file bytes. A crash leaves a pending record.
  store.putArtifact(artifact);
  return artifact;
}

export async function finishArtifact(
  store: WorkspaceStore,
  artifact: SessionArtifact,
  absolutePath: string,
): Promise<void> {
  const hash = artifact.state === "excluded" ? null : await contentHash(absolutePath);
  store.putArtifact({
    ...artifact,
    expectedSha256: hash,
    state: artifact.state === "pending" ? "ready" : artifact.state,
  });
}

/**
 * Detach preserves every file and makes no commit claim. Return both native
 * recorded intents and Git-visible changes since the session baseline,
 * including shell-generated non-document files.
 */
export async function collectUnresolvedSessionPaths(
  store: WorkspaceStore | undefined,
  workspaceId: string,
  workspaceRoot: string,
): Promise<string[]> {
  if (!store) return [];
  const unresolved = new Set(
    store.listArtifacts(workspaceId).filter((item) => item.state !== "excluded").map((item) => item.path),
  );
  const baseline = store.getBaseline(workspaceId);
  if (baseline?.repositoryRoot) {
    const current = await gitDirtySnapshot(baseline.repositoryRoot, workspaceRoot);
    for (const path of new Set([...Object.keys(baseline.snapshot), ...Object.keys(current)])) {
      if (baseline.snapshot[path] !== current[path]) unresolved.add(path);
    }
  }
  return [...unresolved].sort();
}

export interface ArtifactCoverage {
  status: "COVERED" | "NO_RECORDED_WRITES";
  coveredPaths: string[];
  commits: string[];
  excludedPaths: string[];
  proof: Array<{ path: string; sha256: string | null; gitBlobOid: string | null; headSha: string }>;
}

export async function commitSessionArtifacts(
  store: WorkspaceStore,
  workspaceId: string,
  workspaceRoot: string,
): Promise<ArtifactCoverage> {
  const artifacts = store.listArtifacts(workspaceId);
  await assertNoUnattributedChanges(store, workspaceId, workspaceRoot, artifacts);
  if (artifacts.length === 0) {
    return { status: "NO_RECORDED_WRITES", coveredPaths: [], commits: [], excludedPaths: [], proof: [] };
  }
  const excludedPaths = artifacts.filter((item) => item.state === "excluded").map((item) => item.path);
  const eligible = artifacts.filter((item) => item.state !== "excluded");
  const unsafe = eligible.filter((item) => item.state !== "ready");
  if (unsafe.length) {
    throw new Error("CLOSE_INCOMPLETE: unverified session paths: " +
      unsafe.map((item) => item.path + " (" + (item.reason ?? item.state) + ")").join(", "));
  }
  const repositories = new Map<string, SessionArtifact[]>();
  for (const item of eligible) {
    if (!isPathInsideRoot(item.repositoryRoot, workspaceRoot)) {
      throw new Error("CLOSE_INCOMPLETE: repository escaped workspace boundary");
    }
    const items = repositories.get(item.repositoryRoot) ?? [];
    items.push(item);
    repositories.set(item.repositoryRoot, items);
  }

  const coveredPaths: string[] = [];
  const commits: string[] = [];
  const proof: ArtifactCoverage["proof"] = [];
  for (const [root, items] of repositories) {
    const pending: SessionArtifact[] = [];
    for (const item of items) {
      const absolute = root + sep + item.path.split("/").join(sep);
      if ((await contentHash(absolute)) !== item.expectedSha256) {
        throw new Error("CLOSE_INCOMPLETE: session artifact modified after recording: " + item.path);
      }
      const committed = await headBlob(root, item.path);
      const working = item.expectedSha256 === null ? null : await workingBlob(root, item.path);
      if (committed !== working) pending.push(item);
    }
    if (pending.length) {
      const published = await publishGitChanges({
        cwd: root,
        workspaceRoot,
        allowedRoots: [workspaceRoot],
        paths: pending.map((item) => item.path),
        message: "Preserve DevSpace session artifacts",
        push: false,
        expectedHashes: Object.fromEntries(pending.map((item) => [item.path, item.expectedSha256])),
      });
      commits.push(published.commit);
    }
    for (const item of items) {
      const absolute = root + sep + item.path.split("/").join(sep);
      if ((await contentHash(absolute)) !== item.expectedSha256) {
        throw new Error("CLOSE_INCOMPLETE: artifact changed during close: " + item.path);
      }
      const committed = await headBlob(root, item.path);
      const working = item.expectedSha256 === null ? null : await workingBlob(root, item.path);
      if (committed !== working) {
        throw new Error("CLOSE_INCOMPLETE: artifact absent from final Git HEAD: " + item.path);
      }
      coveredPaths.push(item.path);
      proof.push({
        path: item.path, sha256: item.expectedSha256, gitBlobOid: committed,
        headSha: (await git(root, ["rev-parse", "HEAD"])).stdout.trim(),
      });
    }
  }
  return { status: "COVERED", coveredPaths, commits, excludedPaths, proof };
}

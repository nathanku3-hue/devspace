import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ServerConfig } from "./config.js";
import {
  assertWorktreeClosurePolicy,
  assertWorktreeCreationPolicy,
  repositoryPolicyFor,
} from "./portfolio-policy.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

export type GitWorktreeErrorCode =
  | "GIT_NOT_AVAILABLE"
  | "GIT_REPOSITORY_NOT_FOUND"
  | "GIT_REPOSITORY_HAS_NO_COMMITS"
  | "GIT_INVALID_BASE_REF"
  | "GIT_INVALID_BRANCH"
  | "GIT_INVALID_WORKTREE_OPTIONS"
  | "GIT_WORKTREE_ROOT_NOT_IGNORED"
  | "GIT_WORKTREE_ROOT_ESCAPE"
  | "GIT_WORKTREE_ALREADY_REGISTERED"
  | "GIT_WORKTREE_CREATE_FAILED"
  | "GIT_WORKTREE_NOT_REGISTERED"
  | "GIT_WORKTREE_DIRTY"
  | "GIT_WORKTREE_REMOVE_FAILED"
  | "GIT_WORKTREE_STALE_METADATA_REQUIRES_CONFIRMATION";

export class GitWorktreeError extends Error {
  constructor(
    readonly code: GitWorktreeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  branch?: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface RemovedManagedWorktree {
  sourceRoot: string;
  path: string;
  headSha?: string;
  branch?: string;
  removed: boolean;
  staleMetadataPruned: boolean;
}

interface RegisteredWorktree {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  locked?: string;
  prunable?: string;
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  branch?: string;
  createBranch?: boolean;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);
  await assertDirectory(sourcePath, input.sourcePath);

  const sourceRoot = await resolveOwningRepositoryRoot(sourcePath, input.config.allowedRoots);
  await assertWorktreeCreationPolicy(sourceRoot, input.config);
  const branch = normalizeBranch(input.branch);
  const createBranch = input.createBranch ?? false;

  if (createBranch && !branch) {
    throw new GitWorktreeError(
      "GIT_INVALID_WORKTREE_OPTIONS",
      "Cannot create a worktree branch because no branch name was provided.",
    );
  }
  if (branch) await assertValidBranchName(sourceRoot, branch);
  if (branch && !createBranch && input.baseRef !== undefined) {
    throw new GitWorktreeError(
      "GIT_INVALID_WORKTREE_OPTIONS",
      "baseRef cannot be combined with an existing branch attachment. Omit baseRef, or set createBranch=true to create the branch from that ref.",
    );
  }

  const baseRef = branch && !createBranch ? branch : input.baseRef ?? "HEAD";
  const baseSha = branch && !createBranch
    ? await resolveExistingBranchCommit(sourceRoot, branch)
    : await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1", "--untracked-files=all"], sourceRoot)).trim().length > 0;
  const managedRoot = await prepareManagedWorktreeRoot(sourceRoot);
  const worktreePath = await allocateManagedWorktreePath(sourceRoot, managedRoot);

  try {
    const worktreeArgs = branch
      ? createBranch
        ? ["worktree", "add", "-b", branch, worktreePath, baseSha]
        : ["worktree", "add", worktreePath, branch]
      : ["worktree", "add", "--detach", worktreePath, baseSha];
    await git(worktreeArgs, sourceRoot);

    const canonicalPath = await realpath(worktreePath);
    assertCanonicalInside(canonicalPath, await realpath(sourceRoot), "managed worktree");
    assertCanonicalInside(canonicalPath, managedRoot, "managed worktree");

    const registered = await findRegisteredWorktree(sourceRoot, canonicalPath);
    if (!registered) {
      throw new GitWorktreeError(
        "GIT_WORKTREE_CREATE_FAILED",
        `Git created ${canonicalPath}, but did not register it as a linked worktree.`,
      );
    }

    return {
      sourceRoot,
      path: canonicalPath,
      baseRef,
      baseSha,
      branch,
      dirtySource,
      detached: !branch,
      managed: true,
    };
  } catch (error) {
    const registered = await findRegisteredWorktree(sourceRoot, worktreePath).catch(() => undefined);
    if (!registered) await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof GitWorktreeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`,
    );
  }
}

export async function removeManagedWorktree(input: {
  sourceRoot: string;
  worktreePath: string;
  config: ServerConfig;
  pruneStaleMetadata?: boolean;
}): Promise<RemovedManagedWorktree> {
  const sourceRoot = await resolveOwningRepositoryRoot(input.sourceRoot, input.config.allowedRoots);
  await repositoryPolicyFor(sourceRoot, input.config);
  const managedRoot = await validateManagedWorktreeRoot(sourceRoot);
  const worktreePath = resolve(input.worktreePath);
  assertLogicalManagedPath(worktreePath, sourceRoot);

  const registered = await findRegisteredWorktree(sourceRoot, worktreePath);
  const exists = await pathExists(worktreePath);

  if (!registered) {
    if (exists) {
      throw new GitWorktreeError(
        "GIT_WORKTREE_NOT_REGISTERED",
        `Refusing to remove ${worktreePath} because Git does not register it as a linked worktree owned by ${sourceRoot}.`,
      );
    }
    return {
      sourceRoot,
      path: worktreePath,
      removed: false,
      staleMetadataPruned: false,
    };
  }

  if (exists) {
    const canonicalPath = await realpath(worktreePath);
    assertCanonicalInside(canonicalPath, await realpath(sourceRoot), "managed worktree");
    assertCanonicalInside(canonicalPath, managedRoot, "managed worktree");
    const dirty = (await git(["status", "--porcelain=v1", "--untracked-files=all"], canonicalPath)).trim();
    const ignored = (await git([
      "status",
      "--porcelain=v1",
      "--ignored",
      "--untracked-files=normal",
    ], canonicalPath))
      .split(/\r?\n/)
      .filter((line) => line.startsWith("!! "));
    if (dirty || ignored.length > 0) {
      const ignoredSummary = ignored.length > 0
        ? ` Ignored custody entries also exist: ${ignored.slice(0, 8).join(", ")}${ignored.length > 8 ? `, plus ${ignored.length - 8} more` : ""}.`
        : "";
      throw new GitWorktreeError(
        "GIT_WORKTREE_DIRTY",
        `Refusing to close dirty managed worktree ${canonicalPath}. Commit or otherwise rescue tracked and untracked changes, and explicitly remove or archive ignored artifacts first.${ignoredSummary}`,
      );
    }

    const headSha = (await git(["rev-parse", "HEAD"], canonicalPath)).trim();
    const branch = await currentBranch(canonicalPath);
    await assertWorktreeClosurePolicy(sourceRoot, canonicalPath, input.config);
    try {
      await git(["worktree", "remove", "--", canonicalPath], sourceRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GitWorktreeError(
        "GIT_WORKTREE_REMOVE_FAILED",
        `Git refused to remove managed worktree ${canonicalPath}. ${message}`,
      );
    }

    if (await pathExists(canonicalPath) || await findRegisteredWorktree(sourceRoot, canonicalPath)) {
      throw new GitWorktreeError(
        "GIT_WORKTREE_REMOVE_FAILED",
        `Managed worktree removal did not fully retire ${canonicalPath}.`,
      );
    }

    return {
      sourceRoot,
      path: canonicalPath,
      headSha,
      branch,
      removed: true,
      staleMetadataPruned: false,
    };
  }

  if (!registered.prunable) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_REMOVE_FAILED",
      `Managed worktree directory ${worktreePath} is missing, but Git does not mark its metadata prunable. Refusing to mutate repository administration.`,
    );
  }
  if (!input.pruneStaleMetadata) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_STALE_METADATA_REQUIRES_CONFIRMATION",
      `Managed worktree directory ${worktreePath} is missing and Git marks it prunable. Retry with pruneStaleMetadata=true to remove validated stale metadata.`,
    );
  }

  const prunableEntries = (await listRegisteredWorktrees(sourceRoot)).filter((entry) => entry.prunable);
  if (
    prunableEntries.length !== 1 ||
    !samePath(prunableEntries[0].path, registered.path)
  ) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_REMOVE_FAILED",
      `Refusing repository-wide git worktree prune because ${sourceRoot} has ${prunableEntries.length} prunable worktree records; exactly the validated record for ${worktreePath} must be the only candidate.`,
    );
  }

  await git(["worktree", "prune", "--dry-run", "--verbose", "--expire", "now"], sourceRoot);
  await git(["worktree", "prune", "--verbose", "--expire", "now"], sourceRoot);
  if (await findRegisteredWorktree(sourceRoot, worktreePath)) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_REMOVE_FAILED",
      `Git did not prune validated stale metadata for ${worktreePath}.`,
    );
  }

  return {
    sourceRoot,
    path: worktreePath,
    headSha: registered.head,
    branch: registered.branch,
    removed: false,
    staleMetadataPruned: true,
  };
}

async function assertDirectory(path: string, originalPath: string): Promise<void> {
  try {
    const sourceStats = await stat(path);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_NOT_FOUND",
        `Cannot open workspace in worktree mode because the source path is not a directory: ${originalPath}`,
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist: ${originalPath}`,
    );
  }
}

async function resolveOwningRepositoryRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const commonDir = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path)).trim();
    const topLevel = (await git(["rev-parse", "--show-toplevel"], path)).trim();
    const candidate = basename(commonDir).toLowerCase() === ".git" ? dirname(commonDir) : topLevel;
    const canonicalRoot = await realpath(candidate);
    await assertCanonicalAllowed(canonicalRoot, allowedRoots);
    return canonicalRoot;
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a supported non-bare Git repository: ${path}.`,
    );
  }
}

async function assertCanonicalAllowed(path: string, allowedRoots: string[]): Promise<void> {
  for (const allowedRoot of allowedRoots) {
    const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
    if (canonicalAllowedRoot && isPathInsideRoot(path, canonicalAllowedRoot)) return;
  }
  throw new GitWorktreeError(
    "GIT_REPOSITORY_NOT_FOUND",
    `The owning Git repository resolves outside configured allowed roots: ${path}.`,
  );
}

async function prepareManagedWorktreeRoot(sourceRoot: string): Promise<string> {
  const managedRoot = join(sourceRoot, ".worktrees");
  await mkdir(managedRoot, { recursive: true });
  return validateManagedWorktreeRoot(sourceRoot);
}

async function validateManagedWorktreeRoot(sourceRoot: string): Promise<string> {
  const managedRoot = join(sourceRoot, ".worktrees");
  let rootStats;
  try {
    rootStats = await lstat(managedRoot);
  } catch {
    throw new GitWorktreeError(
      "GIT_WORKTREE_ROOT_ESCAPE",
      `Managed worktree root does not exist: ${managedRoot}.`,
    );
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_ROOT_ESCAPE",
      `Managed worktree root must be a real directory, not a file, symlink, or junction: ${managedRoot}.`,
    );
  }

  const canonicalSourceRoot = await realpath(sourceRoot);
  const canonicalManagedRoot = await realpath(managedRoot);
  assertCanonicalInside(canonicalManagedRoot, canonicalSourceRoot, "managed worktree root");

  const ignored = await isManagedRootIgnored(sourceRoot);
  if (!ignored) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_ROOT_NOT_IGNORED",
      `Refusing to create a managed worktree because ${managedRoot} is not ignored. Add "/.worktrees/" to ${join(sourceRoot, ".git", "info", "exclude")} and retry.`,
    );
  }

  return canonicalManagedRoot;
}

async function isManagedRootIgnored(sourceRoot: string): Promise<boolean> {
  try {
    await git(["check-ignore", "-q", "--", ".worktrees/devspace-probe"], sourceRoot);
    return true;
  } catch {
    return false;
  }
}

async function allocateManagedWorktreePath(sourceRoot: string, managedRoot: string): Promise<string> {
  const registered = await listRegisteredWorktrees(sourceRoot);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = join(managedRoot, `devspace-${randomBytes(8).toString("hex")}`);
    if (registered.some((entry) => samePath(entry.path, candidate))) continue;
    if (await pathExists(candidate)) continue;
    assertCanonicalInside(resolve(candidate), managedRoot, "managed worktree destination");
    return candidate;
  }
  throw new GitWorktreeError(
    "GIT_WORKTREE_ALREADY_REGISTERED",
    `Could not allocate a unique managed worktree path under ${managedRoot}.`,
  );
}

function assertLogicalManagedPath(path: string, sourceRoot: string): void {
  const expectedRoot = join(sourceRoot, ".worktrees");
  if (!isPathInsideRoot(path, expectedRoot) || samePath(path, expectedRoot)) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_ROOT_ESCAPE",
      `Managed worktree path must remain below ${expectedRoot}: ${path}.`,
    );
  }
}

function assertCanonicalInside(path: string, root: string, label: string): void {
  if (!isPathInsideRoot(path, root) || samePath(path, root)) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_ROOT_ESCAPE",
      `Canonical ${label} escapes its required root: ${path} is not below ${root}.`,
    );
  }
}

function normalizeBranch(branch: string | undefined): string | undefined {
  const normalized = branch?.trim();
  return normalized || undefined;
}

async function assertValidBranchName(sourceRoot: string, branch: string): Promise<void> {
  try {
    await git(["check-ref-format", "--branch", branch], sourceRoot);
  } catch {
    throw new GitWorktreeError(
      "GIT_INVALID_BRANCH",
      `Cannot open workspace in worktree mode because ${JSON.stringify(branch)} is not a valid branch name.`,
    );
  }
}

async function resolveExistingBranchCommit(sourceRoot: string, branch: string): Promise<string> {
  try {
    return (await git(["show-ref", "--verify", "--hash", `refs/heads/${branch}`], sourceRoot)).trim();
  } catch {
    throw new GitWorktreeError(
      "GIT_INVALID_BRANCH",
      `Cannot attach the managed worktree because local branch ${JSON.stringify(branch)} does not exist. Set createBranch=true to create it from baseRef.`,
    );
  }
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", `${baseRef}^{commit}`], sourceRoot)).trim();
  } catch {
    if (baseRef === "HEAD") {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_HAS_NO_COMMITS",
        "Cannot open workspace in worktree mode because the repository has no commits yet. Create an initial commit first, or use mode=\"checkout\".",
      );
    }
    throw new GitWorktreeError(
      "GIT_INVALID_BASE_REF",
      `Cannot open workspace in worktree mode because baseRef ${JSON.stringify(baseRef)} does not resolve to a commit.`,
    );
  }
}

async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

async function findRegisteredWorktree(sourceRoot: string, path: string): Promise<RegisteredWorktree | undefined> {
  const canonicalCandidate = await realpath(path).catch(() => resolve(path));
  const entries = await listRegisteredWorktrees(sourceRoot);
  for (const entry of entries) {
    const canonicalRegistered = await realpath(entry.path).catch(() => resolve(entry.path));
    if (samePath(canonicalRegistered, canonicalCandidate)) return entry;
  }
  return undefined;
}

async function listRegisteredWorktrees(sourceRoot: string): Promise<RegisteredWorktree[]> {
  const output = await git(["worktree", "list", "--porcelain"], sourceRoot);
  return output
    .split(/\r?\n\r?\n/)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const result: RegisteredWorktree = { path: "", detached: false };
      for (const line of record.split(/\r?\n/)) {
        const separator = line.indexOf(" ");
        const key = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? "" : line.slice(separator + 1);
        if (key === "worktree") result.path = value;
        else if (key === "HEAD") result.head = value;
        else if (key === "branch") result.branch = value.replace(/^refs\/heads\//, "");
        else if (key === "detached") result.detached = true;
        else if (key === "locked") result.locked = value;
        else if (key === "prunable") result.prunable = value;
      }
      return result;
    })
    .filter((entry) => entry.path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    );
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;
    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}

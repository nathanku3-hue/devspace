import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getGitEligibility, git } from "./git.js";
import { isPathInsideRoot } from "./roots.js";

export interface WritableRepository {
  root: string;
  headSha: string;
  branch?: string;
}

/**
 * A broad allowed root is discovery authority, not repository write authority.
 * Every mutation must be rooted at the *actual* canonical Git top level.
 */
export async function assertWritableRepository(workspaceRoot: string): Promise<WritableRepository> {
  const eligible = await getGitEligibility(workspaceRoot);
  if (!eligible.ok || !eligible.gitRoot) {
    throw new Error("READ_ONLY_DISCOVERY: a writable workspace must be a Git checkout with a HEAD commit");
  }
  const [physicalRoot, physicalGitRoot] = await Promise.all([
    realpath(workspaceRoot),
    realpath(eligible.gitRoot),
  ]);
  if (!samePath(physicalRoot, physicalGitRoot)) {
    throw new Error("READ_ONLY_DISCOVERY: open the exact Git repository root before writing or running shell commands");
  }
  const headSha = (await git(eligible.gitRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = (await git(eligible.gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .catch(() => ({ stdout: "" }))).stdout.trim() || undefined;
  return { root: physicalGitRoot, headSha, branch };
}

/**
 * Resolve existing path components without following symlinks, junctions or
 * reparse points. A lexical check alone does not keep writes inside a repo.
 * This is a native-file-tool guard, NOT an OS sandbox for arbitrary shell code.
 */
export async function assertNativeWritePath(workspaceRoot: string, targetPath: string): Promise<void> {
  const base = await realpath(workspaceRoot);
  const target = resolve(targetPath);
  if (!isPathInsideRoot(target, workspaceRoot) || !isPathInsideRoot(target, base)) {
    throw new Error("WRITE_SCOPE_ESCAPE: file resolves outside repository");
  }
  const suffix = relative(base, target);
  if (!suffix || suffix === "." || isAbsolute(suffix)) {
    throw new Error("WRITE_SCOPE_ESCAPE: a file path, not the repository directory, is required");
  }
  let current = base;
  for (const segment of suffix.split(sep)) {
    if (segment.toLowerCase() === ".git") throw new Error("WRITE_SCOPE_PROTECTED: .git is not writable through file tools");
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error("WRITE_SCOPE_ESCAPE: symlink/junction/reparse point is not writable: " + current);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

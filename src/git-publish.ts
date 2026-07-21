import { stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { git } from "./git.js";
import { isPathInsideRoot, resolveAllowedPath } from "./roots.js";

export interface PublishGitChangesInput {
  cwd: string;
  workspaceRoot: string;
  allowedRoots?: string[];
  paths: string[];
  message: string;
  remote?: string;
  branch?: string;
  push?: boolean;
}

export interface PublishGitChangesResult {
  commit: string;
  branch: string;
  remote: string;
  pushed: boolean;
  paths: string[];
  stat: string;
  pushOutput?: string;
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function parseNullSeparated(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function normalizeRepositoryPath(path: string): string {
  return path.split(sep).join("/");
}

async function stagedPaths(gitRoot: string): Promise<string[]> {
  const { stdout } = await git(gitRoot, ["diff", "--cached", "--name-only", "-z"]);
  return parseNullSeparated(stdout);
}

function assertLiteralFilePath(path: string): void {
  if (path.startsWith(":") || /[*?[\0]/.test(path)) {
    throw new Error(`Git pathspec syntax is not allowed; provide an exact file path: ${path}`);
  }
}

async function assertNotDirectory(path: string, originalPath: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) {
      throw new Error(`Directories are not accepted as explicit Git publication paths: ${originalPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertRemoteName(remote: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
    throw new Error(`Invalid Git remote name: ${remote}`);
  }
}

export async function publishGitChanges(
  input: PublishGitChangesInput,
): Promise<PublishGitChangesResult> {
  if (input.paths.length === 0) {
    throw new Error("At least one explicit path is required");
  }

  const message = input.message.trim();
  if (!message) {
    throw new Error("Commit message must not be empty");
  }

  const allowedRoots = input.allowedRoots ?? [input.workspaceRoot];
  const gitRoot = (await git(input.cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!allowedRoots.some((root) => isPathInsideRoot(gitRoot, root))) {
    throw new Error("Git repository is outside the allowed roots");
  }

  const repositoryPaths = Array.from(
    new Map(
      await Promise.all(input.paths.map(async (path) => {
        assertLiteralFilePath(path);
        const absolutePath = resolveAllowedPath(path, input.cwd, allowedRoots);
        await assertNotDirectory(absolutePath, path);
        if (!isPathInsideRoot(absolutePath, gitRoot)) {
          throw new Error(`Path is outside the current Git repository: ${path}`);
        }

        const repositoryPath = normalizeRepositoryPath(relative(gitRoot, absolutePath));
        if (!repositoryPath || repositoryPath === ".") {
          throw new Error("Repository root cannot be staged as an explicit path");
        }

        return [pathKey(repositoryPath), repositoryPath] as const;
      })),
    ).values(),
  );
  const allowedPaths = new Set(repositoryPaths.map(pathKey));

  const alreadyStaged = await stagedPaths(gitRoot);
  const preexistingUnexpected = alreadyStaged.filter((path) => !allowedPaths.has(pathKey(path)));
  if (preexistingUnexpected.length > 0) {
    throw new Error(
      `Refusing to commit because unrelated paths are already staged: ${preexistingUnexpected.join(", ")}`,
    );
  }

  await git(gitRoot, ["--literal-pathspecs", "add", "--", ...repositoryPaths]);

  const staged = await stagedPaths(gitRoot);
  const unexpected = staged.filter((path) => !allowedPaths.has(pathKey(path)));
  if (unexpected.length > 0) {
    throw new Error(`Refusing to commit paths that were not explicitly authorized: ${unexpected.join(", ")}`);
  }
  if (staged.length === 0) {
    throw new Error("No staged changes remain after staging the explicit paths");
  }

  await git(gitRoot, ["diff", "--cached", "--check"]);
  const stat = (await git(gitRoot, ["diff", "--cached", "--stat"])).stdout.trim();

  const currentBranch = (await git(gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!currentBranch) {
    throw new Error("Cannot publish from a detached HEAD");
  }

  const targetBranch = input.branch?.trim() || currentBranch;
  await git(gitRoot, ["check-ref-format", "--branch", targetBranch]);
  if (targetBranch !== currentBranch) {
    throw new Error(
      `Requested branch ${targetBranch} does not match the checked-out branch ${currentBranch}`,
    );
  }

  await git(gitRoot, ["commit", "-m", message]);
  const commit = (await git(gitRoot, ["rev-parse", "HEAD"])).stdout.trim();

  const remote = input.remote?.trim() || "origin";
  assertRemoteName(remote);
  let pushOutput: string | undefined;
  const shouldPush = input.push ?? true;
  if (shouldPush) {
    await git(gitRoot, ["remote", "get-url", remote]);
    try {
      const pushed = await git(
        gitRoot,
        ["push", remote, `HEAD:${targetBranch}`],
        { env: { GIT_TERMINAL_PROMPT: "0" } },
      );
      pushOutput = [pushed.stdout.trim(), pushed.stderr.trim()].filter(Boolean).join("\n");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Commit ${commit} was created, but push to ${remote}/${targetBranch} failed: ${detail}`);
    }
  }

  return {
    commit,
    branch: targetBranch,
    remote,
    pushed: shouldPush,
    paths: staged,
    stat,
    ...(pushOutput ? { pushOutput } : {}),
  };
}

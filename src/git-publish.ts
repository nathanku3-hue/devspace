import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rm, stat as fileStat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { git } from "./git.js";
import { isPathInsideRoot } from "./roots.js";
import { assertNativeWritePath } from "./write-scope.js";

export interface PublishGitChangesInput {
  cwd: string;
  workspaceRoot: string;
  allowedRoots?: string[];
  paths: string[];
  message: string;
  remote?: string;
  branch?: string;
  push?: boolean;
  // Optional physical-byte expectations for close-time session-owned paths.
  expectedHashes?: Record<string, string | null>;
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

function gitEnv(env?: NodeJS.ProcessEnv): { env?: NodeJS.ProcessEnv } {
  return env ? { env } : {};
}

async function stagedPaths(gitRoot: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const { stdout } = await git(gitRoot, ["diff", "--cached", "--name-only", "-z"], gitEnv(env));
  return parseNullSeparated(stdout);
}

async function stagedEntrySnapshot(gitRoot: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const { stdout } = await git(gitRoot, ["ls-files", "--stage", "-z", "--", ...paths]);
  return parseNullSeparated(stdout).sort();
}

async function resolveGitDir(gitRoot: string): Promise<string> {
  const raw = (await git(gitRoot, ["rev-parse", "--git-dir"])).stdout.trim();
  return isAbsolute(raw) ? raw : resolve(gitRoot, raw);
}

async function withPrivateIndex<T>(
  gitRoot: string,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const gitDir = await resolveGitDir(gitRoot);
  const indexPath = resolve(gitDir, `devspace-publish-${randomBytes(8).toString("hex")}.index`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    return await fn(env);
  } finally {
    await rm(indexPath, { force: true });
    await rm(`${indexPath}.lock`, { force: true });
  }
}

function assertLiteralFilePath(path: string): void {
  if (path.startsWith(":") || /[*?[\0]/.test(path)) {
    throw new Error(`Git pathspec syntax is not allowed; provide an exact file path: ${path}`);
  }
}

async function assertNotDirectory(path: string, originalPath: string): Promise<void> {
  try {
    if ((await fileStat(path)).isDirectory()) {
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
  const [physicalGitRoot, physicalCwd, ...physicalAllowedRoots] = await Promise.all([
    realpath(gitRoot),
    realpath(input.cwd),
    ...allowedRoots.map((root) => realpath(root).catch(() => null)),
  ]);
  if (!physicalAllowedRoots.some((root) => root && isPathInsideRoot(physicalGitRoot, root))) {
    throw new Error("Git repository is outside the allowed roots");
  }
  // Git may report a canonical /private/var path while the caller uses /var.
  // Keep the relative Git path in the caller's lexical namespace, after
  // checking the repository's actual location against canonical allowed roots.
  const lexicalGitRoot = resolve(input.cwd, relative(physicalCwd, physicalGitRoot));

  const repositoryPaths = Array.from(
    new Map(
      await Promise.all(input.paths.map(async (path) => {
        assertLiteralFilePath(path);
        const requestedPath = resolve(input.cwd, path);
        // Translate lexical aliases such as macOS /var -> /private/var to
        // the checked physical checkout before enforcing path containment.
        const absolutePath = isPathInsideRoot(requestedPath, lexicalGitRoot)
          ? resolve(physicalGitRoot, relative(lexicalGitRoot, requestedPath))
          : requestedPath;
        if (!isPathInsideRoot(absolutePath, physicalGitRoot)) {
          throw new Error(`Path is outside the current Git repository: ${path}`);
        }
        await assertNotDirectory(absolutePath, path);
        await assertNativeWritePath(physicalGitRoot, absolutePath);

        const repositoryPath = normalizeRepositoryPath(relative(physicalGitRoot, absolutePath));
        if (!repositoryPath || repositoryPath === ".") {
          throw new Error("Repository root cannot be staged as an explicit path");
        }

        return [pathKey(repositoryPath), repositoryPath] as const;
      })),
    ).values(),
  );
  const allowedPaths = new Set(repositoryPaths.map(pathKey));

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

  const alreadyStaged = await stagedPaths(gitRoot);
  const preexistingUnexpected = alreadyStaged.filter((path) => !allowedPaths.has(pathKey(path)));
  const unrelatedSnapshot = await stagedEntrySnapshot(gitRoot, preexistingUnexpected);

  const { staged, stat } = await withPrivateIndex(gitRoot, async (env) => {
    await git(gitRoot, ["--literal-pathspecs", "add", "--", ...repositoryPaths], { env });

    if (input.expectedHashes) {
      for (const path of repositoryPaths) {
        if (!Object.hasOwn(input.expectedHashes, path)) {
          throw new Error(`Missing expected session hash for ${path}`);
        }
        const expected = input.expectedHashes[path];
        const absolute = resolve(gitRoot, path);
        let actual: string | null;
        try {
          const info = await lstat(absolute);
          if (!info.isFile() || info.isSymbolicLink()) {
            throw new Error(`Not a regular non-symlink file: ${path}`);
          }
          actual = createHash("sha256").update(await readFile(absolute)).digest("hex");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          actual = null;
        }
        if (actual !== expected) {
          throw new Error(`Session artifact changed before commit: ${path}`);
        }
      }
    }

    const staged = await stagedPaths(gitRoot, env);
    const unexpected = staged.filter((path) => !allowedPaths.has(pathKey(path)));
    if (unexpected.length > 0) {
      throw new Error(`Refusing to commit paths that were not explicitly authorized: ${unexpected.join(", ")}`);
    }
    if (staged.length === 0) {
      throw new Error("No staged changes remain after staging the explicit paths");
    }

    await git(gitRoot, ["diff", "--cached", "--check"], { env });
    const stat = (await git(gitRoot, ["diff", "--cached", "--stat"], { env })).stdout.trim();
    await git(gitRoot, ["commit", "-m", message], { env });
    return { staged, stat };
  });

  await git(gitRoot, ["--literal-pathspecs", "add", "--", ...repositoryPaths]);
  const leftoverUnexpected = (await stagedPaths(gitRoot))
    .filter((path) => !allowedPaths.has(pathKey(path)))
    .sort((left, right) => pathKey(left).localeCompare(pathKey(right)));
  const expectedUnexpected = [...preexistingUnexpected].sort((left, right) =>
    pathKey(left).localeCompare(pathKey(right)),
  );
  const leftoverSnapshot = await stagedEntrySnapshot(gitRoot, leftoverUnexpected);
  if (
    leftoverUnexpected.length !== expectedUnexpected.length
    || leftoverUnexpected.some((path, index) => pathKey(path) !== pathKey(expectedUnexpected[index] ?? ""))
    || leftoverSnapshot.length !== unrelatedSnapshot.length
    || leftoverSnapshot.some((entry, index) => entry !== unrelatedSnapshot[index])
  ) {
    throw new Error(
      "Commit was created, but the shared index no longer preserves the unrelated staged paths that were present before publication",
    );
  }

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

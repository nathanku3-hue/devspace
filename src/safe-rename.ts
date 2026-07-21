import { lstat, realpath, link, unlink } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { isPathInsideRoot } from "./roots.js";

export interface ErrnoException extends Error {
  errno?: number;
  code?: string;
  path?: string;
  syscall?: string;
}

export function toErrnoException(err: unknown): ErrnoException {
  if (err instanceof Error) {
    return err as ErrnoException;
  }
  if (typeof err === "object" && err !== null) {
    const error = new Error((err as any).message || String(err)) as ErrnoException;
    Object.assign(error, err);
    return error;
  }
  return new Error(String(err)) as ErrnoException;
}

export interface FileSystemOps {
  lstat: (path: string) => Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  realpath: (path: string) => Promise<string>;
  link: (existingPath: string, newPath: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
}

const defaultFsOps: FileSystemOps = {
  lstat,
  realpath,
  link,
  unlink,
};

export async function safeRenameFile(
  workspaceRoot: string | string[],
  sourcePath: string,
  targetPath: string,
  fsOps: FileSystemOps = defaultFsOps
): Promise<void> {
  const allowedRoots = Array.isArray(workspaceRoot) ? workspaceRoot : [workspaceRoot];
  const realRoots = await Promise.all(allowedRoots.map((root) => fsOps.realpath(root)));
  const baseRoot = realRoots[0];

  const absSource = resolve(baseRoot, sourcePath);
  if (!realRoots.some((root) => isPathInsideRoot(absSource, root))) {
    throw new Error(`Source path resolves outside allowed roots: ${sourcePath}`);
  }

  const absTarget = resolve(baseRoot, targetPath);
  if (!realRoots.some((root) => isPathInsideRoot(absTarget, root))) {
    throw new Error(`Target path resolves outside allowed roots: ${targetPath}`);
  }

  let originalSourceStats;
  try {
    originalSourceStats = await fsOps.lstat(absSource);
  } catch (err: unknown) {
    const error = toErrnoException(err);
    if (error.code === "ENOENT") {
      throw new Error(`Source file does not exist: ${sourcePath}`);
    }
    throw error;
  }

  if (originalSourceStats.isSymbolicLink() || !originalSourceStats.isFile()) {
    throw new Error(`Source is not a regular file: ${sourcePath}`);
  }

  const realSource = await fsOps.realpath(absSource);
  if (!realRoots.some((root) => isPathInsideRoot(realSource, root))) {
    throw new Error(`Source path resolves outside allowed roots: ${sourcePath}`);
  }

  const targetParent = dirname(absTarget);
  let realTargetParent;
  try {
    realTargetParent = await fsOps.realpath(targetParent);
  } catch (err: unknown) {
    const error = toErrnoException(err);
    if (error.code === "ENOENT") {
      throw new Error(`Target parent directory does not exist: ${targetParent}`);
    }
    throw error;
  }

  if (!realRoots.some((root) => isPathInsideRoot(realTargetParent, root))) {
    throw new Error(`Target path resolves outside allowed roots: ${targetPath}`);
  }

  const targetParentStats = await fsOps.lstat(realTargetParent);
  if (!targetParentStats.isDirectory()) {
    throw new Error(`Target parent is not a directory: ${targetParent}`);
  }

  const targetBase = basename(absTarget);
  const realTarget = resolve(realTargetParent, targetBase);

  if (realSource === realTarget) {
    throw new Error(`Source and target paths are identical: ${sourcePath}`);
  }

  // Check if target already exists (prevent overwrite)
  let targetExists = false;
  try {
    await fsOps.lstat(realTarget);
    targetExists = true;
  } catch (err: unknown) {
    const error = toErrnoException(err);
    if (error.code !== "ENOENT") throw error;
  }

  if (targetExists) {
    throw new Error(`Target file already exists: ${targetPath}`);
  }

  try {
    await fsOps.link(realSource, realTarget);
  } catch (err: unknown) {
    const error = toErrnoException(err);
    if (error.code === "EEXIST") {
      throw new Error(`Target file already exists: ${targetPath}`);
    }
    throw error;
  }

  try {
    await fsOps.unlink(realSource);
  } catch (unlinkErr: unknown) {
    const error = toErrnoException(unlinkErr);
    // Attempt rollback by removing the target link
    try {
      await fsOps.unlink(realTarget);
    } catch (rollbackErr: unknown) {
      const rbError = toErrnoException(rollbackErr);
      throw new Error(
        `Failed to remove source file after linking (${error.message}) and failed to rollback by removing target file (${rbError.message}). Partial state remains with both paths existing: ${sourcePath} and ${targetPath}`
      );
    }
    throw new Error(
      `Failed to remove source file after linking: ${error.message}. Rollback succeeded and target file was removed.`
    );
  }
}

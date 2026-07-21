import assert from "node:assert/strict";
import { resolve, basename } from "node:path";
import { safeRenameFile, FileSystemOps } from "./safe-rename.js";
import { Stats } from "node:fs";

// Mock stats helper
function createMockStats(isFile: boolean, isDirectory: boolean, isSymbolicLink: boolean): Stats {
  return {
    isFile: () => isFile,
    isDirectory: () => isDirectory,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => isSymbolicLink,
    isFIFO: () => false,
    isSocket: () => false,
    dev: 0,
    ino: 0,
    mode: 0,
    nlink: 0,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: 0,
    blksize: 0,
    blocks: 0,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
    atime: new Date(),
    mtime: new Date(),
    ctime: new Date(),
    birthtime: new Date(),
  };
}

const mockRoot = resolve("/mock/workspace");

// Test 1: Successful rename (mocked)
{
  const unlinked: string[] = [];
  const linked: [string, string][] = [];

  const fsOps: FileSystemOps = {
    realpath: async (p) => p,
    lstat: async (p) => {
      if (p === resolve(mockRoot, "source.txt")) {
        return createMockStats(true, false, false);
      }
      if (p === resolve(mockRoot, "target.txt")) {
        throw { code: "ENOENT" };
      }
      return createMockStats(false, true, false); // parent dir
    },
    link: async (src, dst) => {
      linked.push([src, dst]);
    },
    unlink: async (p) => {
      unlinked.push(p);
    },
  };

  await safeRenameFile(mockRoot, "source.txt", "target.txt", fsOps);

  assert.deepEqual(linked, [[resolve(mockRoot, "source.txt"), resolve(mockRoot, "target.txt")]]);
  assert.deepEqual(unlinked, [resolve(mockRoot, "source.txt")]);
}

// Test 2: Source does not exist
{
  const fsOps: FileSystemOps = {
    realpath: async (p) => p,
    lstat: async (p) => {
      if (p === resolve(mockRoot, "source.txt")) {
        throw { code: "ENOENT" };
      }
      return createMockStats(false, true, false);
    },
    link: async () => {},
    unlink: async () => {},
  };

  await assert.rejects(
    safeRenameFile(mockRoot, "source.txt", "target.txt", fsOps),
    /Source file does not exist: source.txt/
  );
}

// Test 3: Source is directory or symlink
{
  const fsOpsDir: FileSystemOps = {
    realpath: async (p) => p,
    lstat: async (p) => {
      if (p === resolve(mockRoot, "source.txt")) {
        return createMockStats(false, true, false); // directory
      }
      return createMockStats(false, true, false);
    },
    link: async () => {},
    unlink: async () => {},
  };

  await assert.rejects(
    safeRenameFile(mockRoot, "source.txt", "target.txt", fsOpsDir),
    /Source is not a regular file: source.txt/
  );

  const fsOpsSym: FileSystemOps = {
    realpath: async (p) => p,
    lstat: async (p) => {
      if (p === resolve(mockRoot, "source.txt")) {
        return createMockStats(true, false, true); // symlink
      }
      return createMockStats(false, true, false);
    },
    link: async () => {},
    unlink: async () => {},
  };

  await assert.rejects(
    safeRenameFile(mockRoot, "source.txt", "target.txt", fsOpsSym),
    /Source is not a regular file: source.txt/
  );
}

// Test 4: Traversal outside root (source or target)
{
  const fsOps: FileSystemOps = {
    realpath: async (p) => p,
    lstat: async (p) => {
      if (p === resolve(mockRoot, "../source.txt") || p === resolve(mockRoot, "source.txt")) {
        return createMockStats(true, false, false);
      }
      return createMockStats(false, true, false);
    },
    link: async () => {},
    unlink: async () => {},
  };

  await assert.rejects(
    safeRenameFile(mockRoot, "../source.txt", "target.txt", fsOps),
    /Source path resolves outside allowed roots/
  );

  await assert.rejects(
    safeRenameFile(mockRoot, "source.txt", "../target.txt", fsOps),
    /Target path resolves outside allowed roots/
  );
}

// Test 5: Identical paths
{
  const fsOps: FileSystemOps = {
    realpath: async (p) => p,
    lstat: async (p) => {
      if (p === resolve(mockRoot, "source.txt")) {
        return createMockStats(true, false, false);
      }
      return createMockStats(false, true, false);
    },
    link: async () => {},
    unlink: async () => {},
  };

  await assert.rejects(
    safeRenameFile(mockRoot, "source.txt", "source.txt", fsOps),
    /Source and target paths are identical/
  );
}

// Test 6: Target already exists (prevent overwrite)
{
  const fsOps: FileSystemOps = {
    realpath: async (p) => p,
    lstat: async (p) => {
      if (p === resolve(mockRoot, "source.txt") || p === resolve(mockRoot, "target.txt")) {
        return createMockStats(true, false, false);
      }
      return createMockStats(false, true, false);
    },
    link: async () => {},
    unlink: async () => {},
  };

  await assert.rejects(
    safeRenameFile(mockRoot, "source.txt", "target.txt", fsOps),
    /Target file already exists: target.txt/
  );
}

// Test 7: Target parent is not a directory
{
  const fsOps: FileSystemOps = {
    realpath: async (p) => p,
    lstat: async (p) => {
      if (p === resolve(mockRoot, "source.txt")) {
        return createMockStats(true, false, false);
      }
      if (p === resolve(mockRoot, "sub")) {
        return createMockStats(true, false, false); // parent is a file
      }
      if (p === resolve(mockRoot, "sub/target.txt")) {
        throw { code: "ENOENT" };
      }
      return createMockStats(false, true, false);
    },
    link: async () => {},
    unlink: async () => {},
  };

  await assert.rejects(
    safeRenameFile(mockRoot, "source.txt", "sub/target.txt", fsOps),
    /Target parent is not a directory/
  );
}

// Test 8: Unlink failure - rollback succeeds (physical validation)
{
  const unlinked: string[] = [];
  const linked: [string, string][] = [];

  const fsOps: FileSystemOps = {
    realpath: async (p) => p,
    lstat: async (p) => {
      if (p === resolve(mockRoot, "source.txt")) {
        return createMockStats(true, false, false);
      }
      if (p === resolve(mockRoot, "target.txt")) {
        throw { code: "ENOENT" };
      }
      return createMockStats(false, true, false);
    },
    link: async (src, dst) => {
      linked.push([src, dst]);
    },
    unlink: async (p) => {
      if (p === resolve(mockRoot, "source.txt")) {
        throw new Error("Disk read-only");
      }
      unlinked.push(p);
    },
  };

  await assert.rejects(
    safeRenameFile(mockRoot, "source.txt", "target.txt", fsOps),
    /Failed to remove source file after linking: Disk read-only. Rollback succeeded and target file was removed./
  );

  // Assert target was created by link
  assert.deepEqual(linked, [[resolve(mockRoot, "source.txt"), resolve(mockRoot, "target.txt")]]);
  // Assert target was cleaned up by rollback unlink
  assert.deepEqual(unlinked, [resolve(mockRoot, "target.txt")]);
}

// Test 9: Rollback failure - leaves both links (physical validation)
{
  const unlinked: string[] = [];
  const linked: [string, string][] = [];

  const fsOps: FileSystemOps = {
    realpath: async (p) => p,
    lstat: async (p) => {
      if (p === resolve(mockRoot, "source.txt")) {
        return createMockStats(true, false, false);
      }
      if (p === resolve(mockRoot, "target.txt")) {
        throw { code: "ENOENT" };
      }
      return createMockStats(false, true, false);
    },
    link: async (src, dst) => {
      linked.push([src, dst]);
    },
    unlink: async (p) => {
      throw new Error(`Permission denied for ${basename(p)}`);
    },
  };

  await assert.rejects(
    safeRenameFile(mockRoot, "source.txt", "target.txt", fsOps),
    /Failed to remove source file after linking \(Permission denied for source.txt\) and failed to rollback by removing target file \(Permission denied for target.txt\). Partial state remains with both paths existing: source.txt and target.txt/
  );

  assert.deepEqual(linked, [[resolve(mockRoot, "source.txt"), resolve(mockRoot, "target.txt")]]);
  // Both unlinks failed, so unlinked list should be empty
  assert.deepEqual(unlinked, []);
}

console.log("All safe-rename unit tests passed!");

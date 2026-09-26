import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import {
  gitBashCandidatesFromGitExe,
  isWindowsWslOrStoreBash,
  resetWorkspaceShellCacheForTests,
  resolveWorkspaceShell,
} from "./workspace-shell.js";

assert.equal(isWindowsWslOrStoreBash(String.raw`C:\WINDOWS\System32\bash.exe`), true);
assert.equal(isWindowsWslOrStoreBash(String.raw`C:\Windows\Sysnative\bash.exe`), true);
assert.equal(
  isWindowsWslOrStoreBash(String.raw`C:\Users\Lenovo\AppData\Local\Microsoft\WindowsApps\bash.exe`),
  true,
);
assert.equal(isWindowsWslOrStoreBash(String.raw`D:\Git\bin\bash.exe`), false);
assert.equal(isWindowsWslOrStoreBash("/bin/bash"), false);

const fromCmdGit = gitBashCandidatesFromGitExe(String.raw`D:\Git\cmd\git.exe`);
assert.equal(fromCmdGit[0], win32.join(String.raw`D:\Git`, "bin", "bash.exe"));
assert.equal(fromCmdGit[1], win32.join(String.raw`D:\Git`, "usr", "bin", "bash.exe"));
assert.equal(fromCmdGit[2], win32.join(String.raw`D:\Git\cmd`, "bash.exe"));

if (process.platform === "win32") {
  resetWorkspaceShellCacheForTests();
  const shell = resolveWorkspaceShell();
  const nativeGitBash = nativeGitBashExists();
  if (nativeGitBash) {
    assert.equal(shell.kind, "git-bash", JSON.stringify(shell));
    assert.equal(isWindowsWslOrStoreBash(shell.shellPath), false, JSON.stringify(shell));
    assert.equal(existsSync(shell.shellPath), true);
  }
}

function nativeGitBashExists(): boolean {
  const fromGit = whereFirst("git.exe");
  if (fromGit && gitBashCandidatesFromGitExe(fromGit).some((candidate) => existsSync(candidate))) {
    return true;
  }
  const known = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    join(homedir(), "AppData", "Local", "Programs", "Git", "bin", "bash.exe"),
  ].filter((path): path is string => Boolean(path));
  return known.some((path) => existsSync(path));
}

function whereFirst(name: string): string | undefined {
  const result = spawnSync("where", [name], {
    encoding: "utf-8",
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  return result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && existsSync(line));
}

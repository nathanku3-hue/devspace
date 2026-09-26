import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

export type WorkspaceShellKind = "git-bash" | "bash" | "wsl-bash";

export interface WorkspaceShell {
  shellPath: string;
  kind: WorkspaceShellKind;
  source: string;
}

let cached: WorkspaceShell | undefined;

export function isWindowsWslOrStoreBash(shellPath: string): boolean {
  const normalized = shellPath.replace(/\//g, "\\").toLowerCase();
  return (
    /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized) ||
    /\\windowsapps\\bash\.exe$/.test(normalized)
  );
}

export function gitBashCandidatesFromGitExe(gitExePath: string): string[] {
  const cmdDir = win32.dirname(gitExePath);
  const installRoot = win32.dirname(cmdDir);
  return [
    win32.join(installRoot, "bin", "bash.exe"),
    win32.join(installRoot, "usr", "bin", "bash.exe"),
    win32.join(cmdDir, "bash.exe"),
  ];
}

export function resolveWorkspaceShell(): WorkspaceShell {
  cached ??= detectWorkspaceShell();
  return cached;
}

export function resetWorkspaceShellCacheForTests(): void {
  cached = undefined;
}

function detectWorkspaceShell(): WorkspaceShell {
  if (process.platform !== "win32") {
    const { shell } = getShellConfig();
    return { shellPath: shell, kind: "bash", source: "unix" };
  }

  const override = process.env.DEVSPACE_SHELL?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`DEVSPACE_SHELL not found: ${override}`);
    }
    return {
      shellPath: override,
      kind: isWindowsWslOrStoreBash(override) ? "wsl-bash" : "git-bash",
      source: "DEVSPACE_SHELL",
    };
  }

  const nativeGitBash = firstExisting([
    ...whereExecutables("git.exe").flatMap(gitBashCandidatesFromGitExe),
    ...knownGitBashLocations(),
  ]);
  if (nativeGitBash) {
    return { shellPath: nativeGitBash, kind: "git-bash", source: "git-for-windows" };
  }

  const pathBash = whereExecutables("bash.exe").find(
    (candidate) => existsSync(candidate) && !isWindowsWslOrStoreBash(candidate),
  );
  if (pathBash) {
    return { shellPath: pathBash, kind: "git-bash", source: "PATH" };
  }

  const { shell } = getShellConfig();
  return {
    shellPath: shell,
    kind: isWindowsWslOrStoreBash(shell) ? "wsl-bash" : "bash",
    source: "pi-default",
  };
}

function knownGitBashLocations(): string[] {
  const paths: string[] = [];
  if (process.env.ProgramFiles) {
    paths.push(join(process.env.ProgramFiles, "Git", "bin", "bash.exe"));
  }
  if (process.env["ProgramFiles(x86)"]) {
    paths.push(join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"));
  }
  paths.push(join(homedir(), "AppData", "Local", "Programs", "Git", "bin", "bash.exe"));
  return paths;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function whereExecutables(name: string): string[] {
  try {
    const result = spawnSync("where", [name], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && existsSync(line));
  } catch {
    return [];
  }
}

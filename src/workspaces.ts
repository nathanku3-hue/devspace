import { randomUUID } from "node:crypto";
import type { WorkspaceMode, WorkspaceStore } from "./workspace-store.js";
import { mkdir, opendir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree, removeManagedWorktree } from "./git-worktrees.js";
import { git } from "./git.js";
import { assertAllowedPath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  branch?: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  activatedSkillDirs: Set<string>;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
  branch?: string;
  createBranch?: boolean;
}

export interface ClosedWorkspace {
  workspaceId: string;
  root: string;
  sourceRoot?: string;
  mode: WorkspaceMode;
  managed: boolean;
  removed: boolean;
  staleMetadataPruned: boolean;
  headSha?: string;
  branch?: string;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(input: string | OpenWorkspaceInput): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(
        options.path,
        options.baseRef,
        options.branch,
        options.createBranch,
      );
    }

    return this.openCheckoutWorkspace(options.path);
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session || session.status !== "active") {
      throw new Error(`Unknown or closed workspaceId: ${workspaceId}. Call open_workspace first.`);
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              branch: session.branch,
              dirtySource: false,
              detached: !session.branch,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
      activatedSkillDirs: new Set(),
    };
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);

    return restoredWorkspace;
  }

  async closeWorkspace(input: {
    workspaceId: string;
    pruneStaleMetadata?: boolean;
  }): Promise<ClosedWorkspace> {
    const workspace = this.workspaces.get(input.workspaceId);
    const session = this.store?.getSession(input.workspaceId);
    if (!workspace && (!session || session.status !== "active")) {
      throw new Error(`Unknown or closed workspaceId: ${input.workspaceId}. Call open_workspace first.`);
    }

    const root = workspace?.root ?? session!.root;
    const mode = workspace?.mode ?? session!.mode;
    const sourceRoot = workspace?.sourceRoot ?? session?.sourceRoot;
    const managed = workspace?.worktree?.managed ?? session?.managed ?? false;
    let removed = false;
    let staleMetadataPruned = false;
    let headSha = workspace?.worktree?.baseSha ?? session?.headSha ?? session?.baseSha;
    let branch = workspace?.worktree?.branch ?? session?.branch;

    if (mode === "worktree" && managed) {
      if (!sourceRoot) {
        throw new Error(`Managed worktree workspace is missing sourceRoot: ${input.workspaceId}`);
      }
      const result = await removeManagedWorktree({
        sourceRoot,
        worktreePath: root,
        allowedRoots: this.config.allowedRoots,
        pruneStaleMetadata: input.pruneStaleMetadata,
      });
      removed = result.removed;
      staleMetadataPruned = result.staleMetadataPruned;
      headSha = result.headSha ?? headSha;
      branch = result.branch ?? branch;
    }

    this.workspaces.delete(input.workspaceId);
    this.store?.closeSession(input.workspaceId, headSha);

    return {
      workspaceId: input.workspaceId,
      root,
      sourceRoot,
      mode,
      managed,
      removed,
      staleMetadataPruned,
      headSha,
      branch,
    };
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) throw workspaceError;

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    }
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    await mkdir(root, { recursive: true });

    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    return this.createWorkspaceContext({ root, mode: "checkout" });
  }

  private async openWorktreeWorkspace(
    path: string,
    baseRef: string | undefined,
    branch: string | undefined,
    createBranch: boolean | undefined,
  ): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      branch,
      createBranch,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      activatedSkillDirs: new Set(),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      headSha: workspace.worktree?.baseSha,
      branch: workspace.worktree?.branch,
      managed: workspace.worktree?.managed,
    });
    this.workspaces.set(workspace.id, workspace);
    const agentsFiles = this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return { workspace, agentsFiles, availableAgentsFiles };
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      return assertAllowedPath(root, [join(sourceRoot, ".worktrees")]);
    }

    return assertAllowedPath(root, this.config.allowedRoots);
  }

  private loadInitialAgentsFiles(root: string): LoadedAgentsFile[] {
    const agentDir = resolve(this.config.agentDir);

    return loadProjectContextFiles({ cwd: root, agentDir })
      .filter((file) => {
        const path = resolve(file.path);
        if (isPathInsideRoot(path, agentDir)) return true;
        return isPathInsideRoot(path, root) && dirname(path) === root;
      })
      .map((file) => ({
        path: resolve(file.path),
        content: file.content,
      }));
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => contextPathKey(resolve(file.path))));
    const gitPaths = await findGitContextFiles(root);
    const discovered: AvailableAgentsFile[] = [];

    if (gitPaths) {
      for (const path of gitPaths) {
        if (!loadedPaths.has(contextPathKey(path))) discovered.push({ path });
      }
    } else {
      await walkWorkspace(root, async (path, entry) => {
        if (!entry.isFile()) return;
        if (!CONTEXT_FILE_NAMES.has(entry.name)) return;
        if (loadedPaths.has(contextPathKey(path))) return;

        discovered.push({ path });
      });
    }

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const CONTEXT_GIT_PATHS = [
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
  "**/AGENTS.md",
  "**/AGENTS.MD",
  "**/CLAUDE.md",
  "**/CLAUDE.MD",
];
const MAX_FALLBACK_CONTEXT_DEPTH = 8;
const MAX_FALLBACK_CONTEXT_DIRECTORIES = 1_000;
const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".venv",
  "venv",
  "__pycache__",
  "tmp",
  "temp",
]);

function contextPathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function findGitContextFiles(root: string): Promise<string[] | undefined> {
  try {
    const gitRoot = (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const { stdout } = await git(
      gitRoot,
      ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", ...CONTEXT_GIT_PATHS],
      { maxBuffer: 4 * 1024 * 1024 },
    );

    return Array.from(
      new Map(
        stdout
          .split("\0")
          .filter(Boolean)
          .map((path) => resolve(gitRoot, path))
          .filter((path) => isPathInsideRoot(path, root))
          .map((path) => [contextPathKey(path), path] as const),
      ).values(),
    );
  } catch {
    return undefined;
  }
}

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
  depth = 0,
  state = { directories: 0 },
): Promise<void> {
  if (depth > MAX_FALLBACK_CONTEXT_DEPTH) return;
  if (state.directories >= MAX_FALLBACK_CONTEXT_DIRECTORIES) return;
  state.directories += 1;

  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        await walkWorkspace(path, visit, depth + 1, state);
      }
      continue;
    }

    await visit(path, entry);
  }
}

import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const META_ENTRY_SCHEMA = "meta-entry/v1" as const;
export const META_ENTRY_V2_SCHEMA = "meta-entry/v2" as const;
export const PROJECT_STARTUP_CONTEXT_SCHEMA = "project-startup-context/v1" as const;
export const META_ENTRY_ACTIONS = ["CONTINUE", "IDLE"] as const;
const LEGACY_META_ENTRY_ACTIONS = [...META_ENTRY_ACTIONS, "INVALID"] as const;
const STARTUP_SOURCE_STATUSES = ["present", "fresh", "stale", "missing", "invalid"] as const;

export type MetaEntryAction = (typeof META_ENTRY_ACTIONS)[number];
export type StartupSourceStatus = (typeof STARTUP_SOURCE_STATUSES)[number];
export interface ProjectStartupSource {
  id: string;
  path: string;
  status: StartupSourceStatus;
  observedAt?: string;
}
export interface ProjectStartupContext {
  schemaVersion: typeof PROJECT_STARTUP_CONTEXT_SCHEMA;
  status: "READY" | "BLOCKED";
  lines: readonly string[];
  sources: readonly ProjectStartupSource[];
  blockers: readonly string[];
}
export interface MetaEntryV1 {
  schemaVersion: typeof META_ENTRY_SCHEMA;
  action: MetaEntryAction;
  result: string | null;
}
export interface MetaEntryV2 {
  schemaVersion: typeof META_ENTRY_V2_SCHEMA;
  action: MetaEntryAction;
  result: string | null;
  startupContext: ProjectStartupContext;
}
export type MetaEntry = MetaEntryV1 | MetaEntryV2;

export interface MetaContinuationReadiness {
  status: "READY" | "BLOCKED";
  blockers: readonly string[];
}

export interface MetaHarnessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MetaContinuationResult {
  exitCode: number;
  result: string;
}

export type MetaHarnessRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<MetaHarnessRunResult>;

export interface MetaHarnessHost {
  looksLikeRepository(root: string): boolean;
  inspectEntry(root: string): Promise<MetaEntry>;
  continuationReadiness?(root: string): MetaContinuationReadiness;
  continue(root: string): Promise<MetaContinuationResult>;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const META_TIMEOUT_MS = 20 * 60 * 1000;

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function directory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function gitBoundary(root: string): boolean {
  try {
    const stat = lstatSync(join(root, ".git"));
    return !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile());
  } catch {
    return false;
  }
}

function gitCommonDirectory(root: string): string | null {
  const dotGit = join(root, ".git");
  let gitDirectory = dotGit;
  try {
    const stat = lstatSync(dotGit);
    if (stat.isSymbolicLink()) return null;
    if (stat.isFile()) {
      const match = readFileSync(dotGit, "utf8").trim().match(/^gitdir:\s*(.+)$/iu);
      if (!match) return null;
      gitDirectory = resolve(root, match[1]);
    } else if (!stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const commonDirFile = join(gitDirectory, "commondir");
  if (!regularFile(commonDirFile)) return gitDirectory;
  try {
    const relative = readFileSync(commonDirFile, "utf8").trim();
    return relative ? resolve(gitDirectory, relative) : null;
  } catch {
    return null;
  }
}

function pathIsMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function inspectMetaHarnessContinuationReadiness(root: string): MetaContinuationReadiness {
  if (!regularFile(join(root, ".meta-harness", "repo-charter.json"))) {
    return Object.freeze({ status: "READY", blockers: Object.freeze([]) });
  }

  if (regularFile(join(root, ".meta-harness-project.json"))) {
    return Object.freeze({ status: "READY", blockers: Object.freeze([]) });
  }

  const commonGitDirectory = gitCommonDirectory(root);
  if (!commonGitDirectory) {
    return Object.freeze({ status: "READY", blockers: Object.freeze([]) });
  }

  const pointerPath = join(commonGitDirectory, "meta-harness", "decision-plane-v2", "current-world.json");
  if (!pathIsMissing(pointerPath)) {
    return Object.freeze({ status: "READY", blockers: Object.freeze([]) });
  }

  return Object.freeze({
    status: "BLOCKED",
    blockers: Object.freeze([
      "Meta-Harness repo planning is enabled, but .git/meta-harness/decision-plane-v2/current-world.json is missing; automatic continuation would fail before a current WorldHead is available.",
    ]),
  });
}

export function looksLikeMetaHarnessRepository(root: string): boolean {
  if (!gitBoundary(root)) return false;
  return regularFile(join(root, "PRODUCT.md"))
    || regularFile(join(root, ".meta-harness-project.json"))
    || directory(join(root, ".meta-harness"))
    || regularFile(join(root, ".meta-harness", "repo-charter.json"))
    || directory(join(root, ".git", "meta-harness"));
}

export function fixedMetaCommand(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { executable: string; args: string[] } {
  if (platform === "win32") {
    // Use `bash -lc` so that login-shell PATH entries (e.g. ~/.npm-global/bin set via
    // ~/.profile or ~/.bashrc) are sourced before meta-harness is resolved.
    // `wsl.exe -e meta-harness` uses execvpe directly and therefore only searches the
    // WSL default PATH, which does not include user npm-global prefixes on most setups.
    // Each argument is JSON-serialised so that spaces and special characters are safe.
    const shellCmd = ["meta-harness", ...args].map((a) => JSON.stringify(a)).join(" ");
    return { executable: "wsl.exe", args: ["bash", "-lc", shellCmd] };
  }
  return { executable: "meta-harness", args: [...args] };
}

export const runFixedMetaHarness: MetaHarnessRunner = (cwd, args) => new Promise((resolve, reject) => {
  const command = fixedMetaCommand(args);
  const child = spawn(command.executable, command.args, {
    cwd,
    env: { ...process.env },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill("SIGKILL");
    reject(new Error("Meta-Harness continuation exceeded the fixed 20-minute host bound."));
  }, META_TIMEOUT_MS);

  function append(current: string, chunk: Buffer | string): string {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_OUTPUT_BYTES) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("Meta-Harness output exceeded the fixed host bound."));
      }
      return current;
    }
    return current + text;
  }

  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new Error(`Meta-Harness could not start: ${error.message}`));
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ exitCode: code ?? 1, stdout, stderr });
  });
});

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).sort().join("\0") === [...keys].sort().join("\0");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown, max = 10): string[] | null {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) return null;
  return value as string[];
}

function parseStartupContext(value: unknown): ProjectStartupContext {
  const record = recordValue(value);
  if (!record || !exactKeys(record, ["blockers", "lines", "schemaVersion", "sources", "status"])
      || record.schemaVersion !== PROJECT_STARTUP_CONTEXT_SCHEMA
      || !["READY", "BLOCKED"].includes(String(record.status))) {
    throw new Error("Meta-Harness inspect returned an invalid project-startup-context/v1 contract.");
  }
  const lines = stringArray(record.lines);
  const blockers = stringArray(record.blockers);
  if (!lines || !blockers || !Array.isArray(record.sources) || record.sources.length > 20) {
    throw new Error("Meta-Harness inspect returned an invalid project-startup-context/v1 contract.");
  }
  const sources: ProjectStartupSource[] = record.sources.map((candidate) => {
    const source = recordValue(candidate);
    if (!source) throw new Error("Meta-Harness inspect returned an invalid project startup source.");
    const keys = source.observedAt === undefined
      ? ["id", "path", "status"]
      : ["id", "observedAt", "path", "status"];
    if (!exactKeys(source, keys)
        || typeof source.id !== "string"
        || typeof source.path !== "string"
        || !STARTUP_SOURCE_STATUSES.includes(source.status as StartupSourceStatus)
        || (source.observedAt !== undefined && typeof source.observedAt !== "string")) {
      throw new Error("Meta-Harness inspect returned an invalid project startup source.");
    }
    return Object.freeze({
      id: source.id,
      path: source.path,
      status: source.status as StartupSourceStatus,
      ...(source.observedAt === undefined ? {} : { observedAt: source.observedAt }),
    });
  });
  return Object.freeze({
    schemaVersion: PROJECT_STARTUP_CONTEXT_SCHEMA,
    status: record.status as "READY" | "BLOCKED",
    lines: Object.freeze([...lines]),
    sources: Object.freeze(sources),
    blockers: Object.freeze([...blockers]),
  });
}

function parseMetaEntry(text: string): MetaEntry {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Meta-Harness inspect returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = recordValue(value);
  if (!record) throw new Error("Meta-Harness inspect returned a non-object entry contract.");

  if (record.schemaVersion === META_ENTRY_SCHEMA) {
    if (!exactKeys(record, ["action", "result", "schemaVersion"])
        || !LEGACY_META_ENTRY_ACTIONS.includes(record.action as (typeof LEGACY_META_ENTRY_ACTIONS)[number])
        || (record.result !== null && typeof record.result !== "string")) {
      throw new Error("Meta-Harness inspect returned an invalid meta-entry/v1 contract.");
    }
    if (record.action === "INVALID") {
      throw new Error("Meta-Harness reported a legacy INVALID continuation state; treat it as a recoverable inspection diagnostic.");
    }
    return Object.freeze({
      schemaVersion: META_ENTRY_SCHEMA,
      action: record.action as MetaEntryAction,
      result: record.result as string | null,
    });
  }

  if (record.schemaVersion === META_ENTRY_V2_SCHEMA) {
    if (!exactKeys(record, ["action", "result", "schemaVersion", "startupContext"])
        || !META_ENTRY_ACTIONS.includes(record.action as MetaEntryAction)
        || (record.result !== null && typeof record.result !== "string")) {
      throw new Error("Meta-Harness inspect returned an invalid meta-entry/v2 contract.");
    }
    return Object.freeze({
      schemaVersion: META_ENTRY_V2_SCHEMA,
      action: record.action as MetaEntryAction,
      result: record.result as string | null,
      startupContext: parseStartupContext(record.startupContext),
    });
  }

  throw new Error("Meta-Harness inspect returned an unsupported meta-entry contract.");
}

export async function inspectMetaHarnessEntry(
  root: string,
  runner: MetaHarnessRunner = runFixedMetaHarness,
): Promise<MetaEntry> {
  const run = await runner(root, ["inspect", "--json"]);
  if (run.exitCode !== 0) {
    const detail = (run.stderr || run.stdout).trim();
    throw new Error(`Meta-Harness inspect failed${detail ? `: ${detail}` : ` with exit ${run.exitCode}`}`);
  }
  return parseMetaEntry(run.stdout);
}

export async function continueMetaHarness(
  root: string,
  runner: MetaHarnessRunner = runFixedMetaHarness,
): Promise<MetaContinuationResult> {
  const run = await runner(root, []);
  const output = (run.stdout || run.stderr).trimEnd();
  const result = output
    || (run.exitCode === 0
      ? "Meta-Harness continuation completed without product output."
      : `Meta-Harness continuation stopped with exit ${run.exitCode} and no product output.`);

  return Object.freeze({
    exitCode: run.exitCode,
    result,
  });
}

export const defaultMetaHarnessHost: MetaHarnessHost = Object.freeze({
  looksLikeRepository: looksLikeMetaHarnessRepository,
  inspectEntry: (root: string) => inspectMetaHarnessEntry(root),
  continuationReadiness: (root: string) => inspectMetaHarnessContinuationReadiness(root),
  continue: (root: string) => continueMetaHarness(root),
});

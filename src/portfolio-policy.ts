import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ServerConfig } from "./config.js";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);
const POLICY_SCHEMA = "portfolio-custody-policy/v1";
const TERMINAL_MODES = new Set([
  "remote",
  "bundle",
  "remote-or-bundle",
  "remote-and-bundle",
  "external-receipt",
]);

export type PortfolioPolicyErrorCode =
  | "GIT_WORKTREE_POLICY_REQUIRED"
  | "GIT_WORKTREE_POLICY_INVALID"
  | "GIT_WORKTREE_PRIMARY_BRANCH"
  | "GIT_WORKTREE_PRIMARY_DIRTY"
  | "GIT_WORKTREE_PARITY"
  | "GIT_WORKTREE_CAPACITY"
  | "GIT_WORKTREE_ACTIVE_PROCESS"
  | "GIT_WORKTREE_TERMINAL_CUSTODY"
  | "GIT_WORKTREE_ACTIVE_EXCEPTION";

export class PortfolioPolicyError extends Error {
  constructor(
    readonly code: PortfolioPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PortfolioPolicyError";
  }
}

interface PortfolioException {
  id?: string;
  kind?: string;
  path?: string;
  owner?: string;
  reviewCondition?: string;
  expiresAt?: string;
  receiptPath?: string;
}

export interface RepositoryPortfolioPolicy {
  id: string;
  canonicalPath: string;
  remote: string | null;
  declaredIntegrationBranch: string | null;
  permittedPrimaryBranches: string[];
  vendorClassification: string;
  maximumActiveWorktrees: number;
  maximumInactiveWorktrees: number;
  terminalCustodyMode: string;
  externalEvidenceRoot: string;
  externalArchiveRoot: string;
  physicalParityRequired: boolean;
  primaryCleanRequired: boolean;
  exceptions: PortfolioException[];
}

interface PortfolioPolicyDocument {
  schema: string;
  repositories: RepositoryPortfolioPolicy[];
}

interface RegisteredWorktree {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  prunable: boolean;
}

interface ProcessEntry {
  pid: number;
  executable?: string | null;
  commandLine: string;
}

function pathKey(value: string): string {
  const normalized = resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function absolutePolicyPath(value: string, base: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function validateRepositoryPolicy(value: unknown, index: number): RepositoryPortfolioPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PortfolioPolicyError("GIT_WORKTREE_POLICY_INVALID", `repositories[${index}] must be an object.`);
  }
  const repository = value as Partial<RepositoryPortfolioPolicy>;
  const required = [
    "id",
    "canonicalPath",
    "remote",
    "declaredIntegrationBranch",
    "permittedPrimaryBranches",
    "vendorClassification",
    "maximumActiveWorktrees",
    "maximumInactiveWorktrees",
    "terminalCustodyMode",
    "externalEvidenceRoot",
    "externalArchiveRoot",
    "physicalParityRequired",
    "primaryCleanRequired",
    "exceptions",
  ] as const;
  for (const field of required) {
    if (!(field in repository)) {
      throw new PortfolioPolicyError("GIT_WORKTREE_POLICY_INVALID", `repositories[${index}].${field} is required.`);
    }
  }
  if (!repository.id || !repository.canonicalPath) {
    throw new PortfolioPolicyError("GIT_WORKTREE_POLICY_INVALID", `repositories[${index}] requires id and canonicalPath.`);
  }
  if (!Array.isArray(repository.permittedPrimaryBranches) || !Array.isArray(repository.exceptions)) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_POLICY_INVALID",
      `${repository.id}.permittedPrimaryBranches and exceptions must be arrays.`,
    );
  }
  if (
    !Number.isInteger(repository.maximumActiveWorktrees)
    || Number(repository.maximumActiveWorktrees) < 0
    || !Number.isInteger(repository.maximumInactiveWorktrees)
    || Number(repository.maximumInactiveWorktrees) < 0
  ) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_POLICY_INVALID",
      `${repository.id} worktree capacities must be non-negative integers.`,
    );
  }
  if (!TERMINAL_MODES.has(String(repository.terminalCustodyMode))) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_POLICY_INVALID",
      `${repository.id}.terminalCustodyMode is unsupported: ${repository.terminalCustodyMode}.`,
    );
  }
  return repository as RepositoryPortfolioPolicy;
}

async function loadPolicy(config: ServerConfig): Promise<PortfolioPolicyDocument> {
  if (!config.portfolioPolicyPath) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_POLICY_REQUIRED",
      "Managed worktree operations require DEVSPACE_PORTFOLIO_POLICY to reference the external portfolio custody policy.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(config.portfolioPolicyPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_POLICY_INVALID",
      `Portfolio policy is unreadable or invalid JSON: ${config.portfolioPolicyPath}. ${message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PortfolioPolicyError("GIT_WORKTREE_POLICY_INVALID", "Portfolio policy must be a JSON object.");
  }
  const document = parsed as Partial<PortfolioPolicyDocument>;
  if (document.schema !== POLICY_SCHEMA || !Array.isArray(document.repositories)) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_POLICY_INVALID",
      `Portfolio policy must use schema ${POLICY_SCHEMA} with a repositories array.`,
    );
  }
  return {
    schema: document.schema,
    repositories: document.repositories.map(validateRepositoryPolicy),
  };
}

export async function repositoryPolicyFor(sourceRoot: string, config: ServerConfig): Promise<RepositoryPortfolioPolicy> {
  const document = await loadPolicy(config);
  const canonicalRoot = await realpath(sourceRoot);
  const matching = document.repositories.filter((repository) => samePath(repository.canonicalPath, canonicalRoot));
  if (matching.length !== 1) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_POLICY_REQUIRED",
      matching.length === 0
        ? `No portfolio policy entry exists for ${canonicalRoot}.`
        : `Multiple portfolio policy entries resolve to ${canonicalRoot}.`,
    );
  }
  return matching[0];
}

async function currentBranch(sourceRoot: string): Promise<string | undefined> {
  try {
    return (await git(sourceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function listRegisteredWorktrees(sourceRoot: string): Promise<RegisteredWorktree[]> {
  const output = (await git(sourceRoot, ["worktree", "list", "--porcelain"])).stdout;
  return output
    .split(/\r?\n\r?\n/)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const entry: RegisteredWorktree = { path: "", detached: false, prunable: false };
      for (const line of record.split(/\r?\n/)) {
        const separator = line.indexOf(" ");
        const key = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? "" : line.slice(separator + 1);
        if (key === "worktree") entry.path = value;
        else if (key === "HEAD") entry.head = value;
        else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, "");
        else if (key === "detached") entry.detached = true;
        else if (key === "prunable") entry.prunable = true;
      }
      return entry;
    })
    .filter((entry) => entry.path);
}

async function listPhysicalWorktrees(sourceRoot: string): Promise<string[]> {
  const managedRoot = join(sourceRoot, ".worktrees");
  try {
    const entries = await readdir(managedRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(managedRoot, entry.name));
  } catch {
    return [];
  }
}

function exceptionExpired(exception: PortfolioException): boolean {
  if (!exception.expiresAt) return false;
  const parsed = Date.parse(exception.expiresAt);
  return Number.isFinite(parsed) && parsed <= Date.now();
}

async function exceptionActive(exception: PortfolioException, sourceRoot: string): Promise<boolean> {
  if (exceptionExpired(exception) || !String(exception.reviewCondition || "").trim()) return false;
  if (!exception.receiptPath) return true;
  try {
    JSON.parse(await readFile(absolutePolicyPath(exception.receiptPath, sourceRoot), "utf8"));
    return true;
  } catch {
    return false;
  }
}

async function activePathExceptions(policy: RepositoryPortfolioPolicy, sourceRoot: string): Promise<Map<string, PortfolioException>> {
  const entries = new Map<string, PortfolioException>();
  for (const exception of policy.exceptions) {
    if (!exception.path || !(await exceptionActive(exception, sourceRoot))) continue;
    entries.set(pathKey(exception.path), exception);
  }
  return entries;
}

async function windowsProcesses(): Promise<ProcessEntry[]> {
  const command = [
    "$ErrorActionPreference='Stop'",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      pid: Number(entry.ProcessId),
      executable: entry.ExecutablePath || null,
      commandLine: entry.CommandLine || "",
    })).filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
  } catch {
    return [];
  }
}

async function unixProcesses(): Promise<ProcessEntry[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], {
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/).map((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match ? { pid: Number(match[1]), commandLine: match[2] } : null;
    }).filter((entry): entry is ProcessEntry => Boolean(entry));
  } catch {
    return [];
  }
}

async function processes(): Promise<ProcessEntry[]> {
  if (process.platform === "win32") return windowsProcesses();
  const windows = await windowsProcesses();
  return windows.length > 0 ? windows : unixProcesses();
}

function commandLineContainsPath(commandLine: string, targetPath: string): boolean {
  const normalizedCommand = commandLine.replace(/\\/g, "/").toLowerCase();
  const normalizedPath = resolve(targetPath).replace(/\\/g, "/").toLowerCase();
  return normalizedCommand.includes(normalizedPath);
}

async function processAssignments(paths: string[]): Promise<Map<string, ProcessEntry[]>> {
  const result = new Map(paths.map((entry) => [pathKey(entry), [] as ProcessEntry[]]));
  const ordered = [...paths].sort((left, right) => right.length - left.length);
  for (const entry of await processes()) {
    if (entry.pid === process.pid) continue;
    const matching = ordered.find((candidate) => commandLineContainsPath(entry.commandLine, candidate));
    if (matching) result.get(pathKey(matching))?.push(entry);
  }
  return result;
}

async function inspectTopology(sourceRoot: string, policy: RepositoryPortfolioPolicy) {
  const registered = (await listRegisteredWorktrees(sourceRoot)).filter((entry) => !samePath(entry.path, sourceRoot));
  const physical = await listPhysicalWorktrees(sourceRoot);
  const registeredKeys = new Set(registered.map((entry) => pathKey(entry.path)));
  const physicalKeys = new Set(physical.map(pathKey));
  const exceptions = await activePathExceptions(policy, sourceRoot);
  const unexplainedPhysical = physical.filter((entry) => !registeredKeys.has(pathKey(entry)) && !exceptions.has(pathKey(entry)));
  const unexplainedRegistered = registered.filter((entry) => {
    const key = pathKey(entry.path);
    return (!physicalKeys.has(key) || entry.prunable) && !exceptions.has(key);
  });
  const assignments = await processAssignments([...physical, ...registered.map((entry) => entry.path)]);
  let active = 0;
  let inactive = 0;
  for (const entry of registered) {
    const key = pathKey(entry.path);
    const isPhysical = physicalKeys.has(key);
    if (!isPhysical) continue;
    if ((assignments.get(key)?.length || 0) > 0 || exceptions.has(key)) active += 1;
    else inactive += 1;
  }
  for (const entry of unexplainedPhysical) {
    if ((assignments.get(pathKey(entry))?.length || 0) > 0) active += 1;
    else inactive += 1;
  }
  return { registered, physical, unexplainedPhysical, unexplainedRegistered, assignments, exceptions, active, inactive };
}

export async function assertWorktreeCreationPolicy(sourceRoot: string, config: ServerConfig): Promise<void> {
  const policy = await repositoryPolicyFor(sourceRoot, config);
  const branch = await currentBranch(sourceRoot);
  if (!branch || !policy.permittedPrimaryBranches.includes(branch)) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_PRIMARY_BRANCH",
      `Refusing managed worktree creation because primary branch ${branch || "DETACHED"} is not permitted for ${policy.id}.`,
    );
  }
  if (policy.primaryCleanRequired) {
    const status = (await git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
    if (status) {
      throw new PortfolioPolicyError(
        "GIT_WORKTREE_PRIMARY_DIRTY",
        `Refusing managed worktree creation because ${policy.id} requires a clean primary checkout.`,
      );
    }
  }
  const topology = await inspectTopology(sourceRoot, policy);
  if (
    policy.physicalParityRequired
    && (topology.unexplainedPhysical.length > 0 || topology.unexplainedRegistered.length > 0)
  ) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_PARITY",
      `Refusing managed worktree creation because physical/registered parity is unexplained for ${policy.id}.`,
    );
  }
  if (topology.active + 1 > policy.maximumActiveWorktrees || topology.inactive > policy.maximumInactiveWorktrees) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_CAPACITY",
      `Refusing managed worktree creation because ${policy.id} capacity would be exceeded: active=${topology.active + 1}/${policy.maximumActiveWorktrees}, inactive=${topology.inactive}/${policy.maximumInactiveWorktrees}.`,
    );
  }
}

async function recursiveBundleFiles(root: string, limit = 100): Promise<string[]> {
  const resolvedRoot = resolve(root);
  try {
    if (!(await stat(resolvedRoot)).isDirectory()) return [];
  } catch {
    return [];
  }
  const pending = [resolvedRoot];
  const bundles: string[] = [];
  while (pending.length > 0 && bundles.length < limit) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".bundle")) bundles.push(entryPath);
      if (bundles.length >= limit) break;
    }
  }
  return bundles;
}

async function remoteContainsHead(sourceRoot: string, head: string): Promise<boolean> {
  try {
    const output = (await git(sourceRoot, ["branch", "-r", "--contains", head, "--format=%(refname:short)"])).stdout.trim();
    return Boolean(output);
  } catch {
    return false;
  }
}

async function bundleContainsHead(sourceRoot: string, archiveRoot: string, head: string): Promise<boolean> {
  for (const bundlePath of await recursiveBundleFiles(archiveRoot)) {
    try {
      const output = (await git(sourceRoot, ["bundle", "list-heads", bundlePath])).stdout;
      if (output.split(/\r?\n/).some((line) => line.startsWith(`${head} `))) return true;
    } catch {
      // Continue through other independently retained bundles.
    }
  }
  return false;
}

async function externalReceiptVerified(policy: RepositoryPortfolioPolicy, sourceRoot: string): Promise<boolean> {
  for (const exception of policy.exceptions) {
    if (exception.kind !== "terminal-custody" || !exception.receiptPath || !(await exceptionActive(exception, sourceRoot))) continue;
    try {
      const receipt = JSON.parse(await readFile(absolutePolicyPath(exception.receiptPath, sourceRoot), "utf8"));
      if (receipt?.custodyVerified === true) return true;
    } catch {
      // Invalid receipts are not custody.
    }
  }
  return false;
}

async function assertTerminalCustody(
  sourceRoot: string,
  worktreePath: string,
  policy: RepositoryPortfolioPolicy,
): Promise<void> {
  const head = (await git(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  const remote = await remoteContainsHead(sourceRoot, head);
  const bundle = await bundleContainsHead(sourceRoot, policy.externalArchiveRoot, head);
  const receipt = await externalReceiptVerified(policy, sourceRoot);
  const pass = policy.terminalCustodyMode === "remote"
    ? remote
    : policy.terminalCustodyMode === "bundle"
      ? bundle
      : policy.terminalCustodyMode === "remote-or-bundle"
        ? remote || bundle
        : policy.terminalCustodyMode === "remote-and-bundle"
          ? remote && bundle
          : receipt;
  if (!pass) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_TERMINAL_CUSTODY",
      `Refusing managed worktree closure because ${policy.terminalCustodyMode} custody is absent for ${head}.`,
    );
  }
}

export async function assertWorktreeClosurePolicy(
  sourceRoot: string,
  worktreePath: string,
  config: ServerConfig,
): Promise<void> {
  const policy = await repositoryPolicyFor(sourceRoot, config);
  const exceptions = await activePathExceptions(policy, sourceRoot);
  const activeException = exceptions.get(pathKey(worktreePath));
  if (activeException) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_ACTIVE_EXCEPTION",
      `Refusing managed worktree closure because active exception ${activeException.id || activeException.kind || "unnamed"} protects ${worktreePath}.`,
    );
  }
  const assignments = await processAssignments([worktreePath]);
  const activeProcesses = assignments.get(pathKey(worktreePath)) || [];
  if (activeProcesses.length > 0) {
    throw new PortfolioPolicyError(
      "GIT_WORKTREE_ACTIVE_PROCESS",
      `Refusing managed worktree closure because process ${activeProcesses.map((entry) => entry.pid).join(", ")} uses ${worktreePath}.`,
    );
  }
  await assertTerminalCustody(sourceRoot, worktreePath, policy);
}

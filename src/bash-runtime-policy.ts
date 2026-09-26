import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export type RuntimeCapability = "workspace_shell" | "production_runtime_control";

export interface RuntimePolicyContext {
  originPids: number[];
  cloudflaredPids: number[];
  serviceNames: string[];
  supervisorTaskNames: string[];
}

export interface BashPolicyDecision {
  allowed: boolean;
  capability: RuntimeCapability;
  reason?: string;
}

const SETUP_LAUNCHER = /setup[_-]?devspace\.ps1/i;
const OPERATOR_STOP = /operator-stop-devspace\.ps1/i;
const SUPERVISOR_SCRIPT = /(?:install-devspace-supervisor|devspace-supervisor)\.ps1/i;
const WORKTREE_SETUP = /\.worktrees[/\\].*setup[_-]?devspace\.ps1/i;
const STOP_SWITCH = /(^|[\s"'`])-Stop(\b|$)/;
const TERMINATION_VERB =
  /\b(stop-process|taskkill|stop-service|kill|pkill|ntsd|wmic\.exe|wmic)\b/i;
const SC_STOP = /\bsc(\.exe)?\s+(stop|delete|config|failure)\b/i;
const SCHTASKS_MUTATE = /\bschtasks(\.exe)?\s+(\/delete|\/end|\/change|\/disable)\b/i;
const POWERSHELL_TASK_MUTATE = /\b(stop|disable|unregister|set)-scheduledtask\b/i;
const NSSM_STOP = /\bnssm(\.exe)?\s+(stop|remove|set)\b/i;
const PROTECTED_IMAGE = /\b(cloudflared(\.exe)?)\b/i;
const INDISCRIMINATE_NODE_KILL =
  /\b(taskkill|stop-process).*\b(node(\.exe)?)\b|\bget-process\s+node\b.*\bstop-process\b/i;

const DEFAULT_SERVICES = ["DevSpaceOrigin", "DevSpaceTunnel"];
const DEFAULT_TASKS = ["DevSpaceOriginSupervisor"];

export function loadRuntimePolicyContext(originPid = process.pid): RuntimePolicyContext {
  const originPids = new Set<number>([originPid]);
  const cloudflaredPids = new Set<number>();
  try {
    const runtimePath = join(homedir(), ".devspace", "runtime.json");
    const raw = readFileSync(runtimePath, "utf8");
    const parsed = JSON.parse(raw) as { devspacePid?: number; cloudflaredPid?: number };
    if (Number.isInteger(parsed.devspacePid) && parsed.devspacePid! > 0) {
      originPids.add(parsed.devspacePid!);
    }
    if (Number.isInteger(parsed.cloudflaredPid) && parsed.cloudflaredPid! > 0) {
      cloudflaredPids.add(parsed.cloudflaredPid!);
    }
  } catch {
    // Missing or unreadable runtime still protects this serve process.
  }
  return {
    originPids: [...originPids],
    cloudflaredPids: [...cloudflaredPids],
    serviceNames: DEFAULT_SERVICES,
    supervisorTaskNames: DEFAULT_TASKS,
  };
}

export function evaluateBashRuntimePolicy(
  command: string,
  context: RuntimePolicyContext,
): BashPolicyDecision {
  const reason = classifyProductionRuntimeControl(command, context);
  if (reason) {
    return {
      allowed: false,
      capability: "production_runtime_control",
      reason,
    };
  }
  return { allowed: true, capability: "workspace_shell" };
}

export function classifyProductionRuntimeControl(
  command: string,
  context: RuntimePolicyContext,
): string | null {
  const text = command ?? "";
  if (!text.trim()) return null;

  if (WORKTREE_SETUP.test(text) || (SETUP_LAUNCHER.test(text) && /[/\\]\.worktrees[/\\]/i.test(text))) {
    return "MCP bash cannot invoke production setup from a Git worktree.";
  }
  if (SETUP_LAUNCHER.test(text) && STOP_SWITCH.test(text)) {
    return "MCP bash cannot pass -Stop to a DevSpace setup launcher.";
  }
  if (SETUP_LAUNCHER.test(text)) {
    return "MCP bash cannot invoke the production DevSpace setup launcher.";
  }
  if (OPERATOR_STOP.test(text)) {
    return "MCP bash cannot invoke the operator stop script.";
  }
  if (SUPERVISOR_SCRIPT.test(text)) {
    return "MCP bash cannot invoke or install the production runtime supervisor.";
  }

  const protectedPids = new Set<number>([...context.originPids, ...context.cloudflaredPids]);
  const mentionedPids = extractPids(text);
  const hitsProtectedPid = mentionedPids.some((pid) => protectedPids.has(pid));

  if (hitsProtectedPid && (TERMINATION_VERB.test(text) || /\bstop-process\b/i.test(text))) {
    return "MCP bash cannot terminate the production origin or its tunnel process.";
  }

  if (PROTECTED_IMAGE.test(text) && (TERMINATION_VERB.test(text) || /\btaskkill\b/i.test(text))) {
    return "MCP bash cannot terminate cloudflared.";
  }

  if (INDISCRIMINATE_NODE_KILL.test(text)) {
    return "MCP bash cannot indiscriminately terminate node.exe (the production origin).";
  }

  const services = context.serviceNames.map((name) => name.toLowerCase());
  const tasks = context.supervisorTaskNames.map((name) => name.toLowerCase());
  const lower = text.toLowerCase();
  if (SC_STOP.test(text) && services.some((name) => lower.includes(name.toLowerCase()))) {
    return "MCP bash cannot stop or reconfigure the DevSpace Windows service.";
  }
  if (/\bstop-service\b/i.test(text) && services.some((name) => lower.includes(name.toLowerCase()))) {
    return "MCP bash cannot stop the DevSpace Windows service.";
  }
  if (SCHTASKS_MUTATE.test(text) && tasks.some((name) => lower.includes(name.toLowerCase()))) {
    return "MCP bash cannot disable the DevSpace supervisor task.";
  }
  if (POWERSHELL_TASK_MUTATE.test(text) && tasks.some((name) => lower.includes(name.toLowerCase()))) {
    return "MCP bash cannot mutate or stop the DevSpace supervisor task.";
  }
  if (POWERSHELL_TASK_MUTATE.test(text) && lower.includes("devspaceoriginuser")) {
    return "MCP bash cannot mutate or stop the DevSpace origin task.";
  }
  if (NSSM_STOP.test(text) && services.some((name) => lower.includes(name.toLowerCase()))) {
    return "MCP bash cannot nssm-stop the DevSpace service.";
  }

  return null;
}

function extractPids(command: string): number[] {
  const pids: number[] = [];
  const patterns = [
    /(?:-id\s+|\/pid\s+|-pid\s+|kill\s+(?:-9\s+)?)(\d+)/gi,
    /\bprocessid\s*=\s*(\d+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > 0) pids.push(value);
    }
  }
  return pids;
}

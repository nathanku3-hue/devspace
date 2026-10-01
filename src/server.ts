import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { isAllowedHostHeader, loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
  type ToolResponse,
} from "./pi-tools.js";
import { safeRenameFile } from "./safe-rename.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { formatPathForPrompt } from "./skills.js";
import { publishGitChanges } from "./git-publish.js";
import {
  DEFAULT_BATCH_READ_LIMIT,
  MAX_BATCH_READ_CHARACTERS,
  MAX_BATCH_READ_FILES,
  MAX_BATCH_READ_LIMIT,
  readWorkspaceFiles,
} from "./read-files.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { globalShellExecutionLimiter } from "./shell-execution-limiter.js";
import { killTrackedShellProcesses } from "./shell-runtime.js";
import { WebLaunchBrowserController } from "./web-launch-browser.js";
import { registerWebLaunchTool } from "./web-launch-tools.js";
import { AuditReturnController } from "./audit-return.js";
import { registerAuditReturnTools } from "./audit-return-tools.js";
import { SourceResolveController } from "./source-resolve.js";
import { registerSourceResolveTools } from "./source-resolve-tools.js";
import { ReviewReturnController } from "./review-return.js";
import { registerReviewReturnTools } from "./review-return-tools.js";
import {
  defaultMetaHarnessHost,
  type MetaContinuationReadiness,
  type MetaEntry,
  type MetaHarnessHost,
} from "./meta-harness.js";
import {
  LongTaskOperationManager,
  type LongTaskOperationSnapshot,
} from "./long-task-operations.js";

export const nativeTaskValidationOutputSchema = z.object({
  taskId: z.string(),
  outcome: z.enum(["READY", "DONE", "UNVERIFIED", "BLOCKED"]),
  productResult: z.string(),
  blocker: z.string(),
  completedAt: z.string(),
  validation: z.array(
    z.object({
      argv: z.array(z.string()),
      cwd: z.string(),
      passed: z.boolean(),
      exitCode: z.number().nullable(),
      durationMs: z.number(),
      output: z.string(),
    }),
  ),
});

export interface LongTaskToolResult {
  output: string;
  response?: ToolResponse;
  taskValidation?: z.infer<typeof nativeTaskValidationOutputSchema>;
}

const DEFAULT_FAST_PATH_QUEUE_WAIT_MS = 8_000;
const DEFAULT_FAST_PATH_EXECUTION_MS = 15_000;

export type McpTransportMode = "stateless" | "stateful";

export function resolveMcpTransportMode(value: string | undefined): McpTransportMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "stateless") return "stateless";
  if (normalized === "stateful") return "stateful";
  throw new Error(
    `Invalid DEVSPACE_MCP_TRANSPORT_MODE: ${value}. Expected "stateless" or "stateful".`,
  );
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const FAST_PATH_QUEUE_WAIT_MS = positiveIntegerEnv(
  "DEVSPACE_FAST_PATH_QUEUE_WAIT_MS",
  DEFAULT_FAST_PATH_QUEUE_WAIT_MS,
);
const FAST_PATH_EXECUTION_MS = positiveIntegerEnv(
  "DEVSPACE_FAST_PATH_EXECUTION_MS",
  positiveIntegerEnv("DEVSPACE_FAST_PATH_TIMEOUT_MS", DEFAULT_FAST_PATH_EXECUTION_MS),
);
export const globalLongTaskOperations = new LongTaskOperationManager<LongTaskToolResult>(100);

type Transport = StreamableHTTPServerTransport;

const MCP_SESSION_IDLE_MS = 30 * 60_000;
const MAX_MCP_SESSIONS = 64;
const WORKSPACE_MEMORY_IDLE_MS = 15 * 60_000;
const REAPER_INTERVAL_MS = 60_000;
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const OPEN_WORKSPACE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const CREATE_WORKTREE_WORKSPACE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const CLOSE_WORKSPACE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const REVIEW_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const META_CONTINUE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

interface RunningServer {
  app: express.Express;
  config: ServerConfig;
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

interface ToolNames {
  openWorkspace: "open_workspace";
  createWorktreeWorkspace: "create_worktree_workspace";
  closeWorkspace: "close_workspace";
  read: "read_file" | "read";
  readBatch: "read_files";
  write: "write_file" | "write";
  edit: "edit_file" | "edit";
  grep: "grep_files" | "grep";
  glob: "find_files" | "glob";
  ls: "list_directory" | "ls";
  shell: "run_shell" | "bash";
}

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  queueWaitMs?: number;
  executionMs?: number;
  limiterActive?: number;
  limiterQueued?: number;
  limiterActiveForWorkspace?: number;
  error?: string;
}

interface ShellLimiterTelemetry {
  active: number;
  queued: number;
  activeForWorkspace: number;
}

function shellLimiterTelemetry(workspaceRoot: string): ShellLimiterTelemetry {
  const snapshot = globalShellExecutionLimiter.snapshot();
  return {
    active: snapshot.active,
    queued: snapshot.queued,
    activeForWorkspace: snapshot.activeByKey[workspaceRoot] ?? 0,
  };
}

function diagnosticNumber(
  diagnostics: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = diagnostics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDurationMs(durationMs: number): string {
  return durationMs >= 1000 && durationMs % 1000 === 0
    ? `${durationMs / 1000}s`
    : `${durationMs}ms`;
}

function toolNamesFor(config: ServerConfig): ToolNames {
  return config.toolNaming === "short"
    ? {
        openWorkspace: "open_workspace",
        createWorktreeWorkspace: "create_worktree_workspace",
        closeWorkspace: "close_workspace",
        read: "read",
        readBatch: "read_files",
        write: "write",
        edit: "edit",
        grep: "grep",
        glob: "glob",
        ls: "ls",
        shell: "bash",
      }
    : {
        openWorkspace: "open_workspace",
        createWorktreeWorkspace: "create_worktree_workspace",
        closeWorkspace: "close_workspace",
        read: "read_file",
        readBatch: "read_files",
        write: "write_file",
        edit: "edit_file",
        grep: "grep_files",
        glob: "find_files",
        ls: "list_directory",
        shell: "run_shell",
      };
}

function serverInstructions(config: ServerConfig, toolNames: ToolNames): string {
  const inspection =
    `Prefer ${toolNames.readBatch} when two or more known text files are needed in the same reasoning step; use ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for single-file, search, and directory discovery. These native inspection tools do not consume shell execution slots, so do not use ${toolNames.shell} for file search or directory listing when a native tool fits. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} or ${toolNames.readBatch} to read that skill's path before proceeding. Skill paths may be outside the workspace, but read tools only permit advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under paths listed in availableAgentsFiles, use ${toolNames.readBatch} to load multiple relevant instruction files in one call, or ${toolNames.read} for one file, and follow them. `;

  const showChanges =
    config.widgets === "changes"
      ? " After creating, editing, or overwriting files, call show_changes once after the related file changes are complete so the user can see the aggregate diff."
      : "";

  return `Use DevSpace as a local coding workspace. Call ${toolNames.openWorkspace} once to open an existing project directory or checkout and obtain a workspaceId; it does not create missing folders. Use ${toolNames.createWorktreeWorkspace} only when an isolated managed Git worktree is actually needed. Reuse the returned workspaceId for all later file, search, edit, write, show-changes, shell, and Git publication tools in that folder; do not reopen the same folder unless the workspaceId is rejected as unknown, the user explicitly asks to reopen, or you intentionally switch to a different folder/worktree. For Meta-Harness repositories, use metaStartup as the authoritative startup-loading state. READY means metaStartup.lines is the canonical repo-declared startup projection; do not reconstruct project state from chat history or undeclared legacy context files. BLOCKED means do not invoke continuation or fall back to undeclared context; treat the listed blockers as recoverable repository-context gaps rather than an owner gate. UNDECLARED means Meta-Harness was detected but inspect returned legacy meta-entry/v1 without repo-declared startup context: do not claim startup context is loaded and do not reconstruct it from chat history. INSPECTION_FAILED is a recoverable host diagnostic, not a product stop. When metaContinuation.status=BLOCKED, do not invoke continue_meta_harness and do not synthesize Meta-Harness decision-plane state from DevSpace. A concrete task in the user's current turn is the velocity-first path: use the returned startup context and execute that task directly instead of invoking continuation merely because metaEntry.action=CONTINUE. Opening a workspace is also a complete user action, not implicit resume intent. Invoke continue_meta_harness only when the user explicitly asks to resume/continue retained Meta-Harness work. Automatically invoke it at most once per user turn. If continue_meta_harness returns STOPPED or BLOCKED, or the call errors, do not retry it automatically in the same turn; continue the user's concrete task with scoped tools when possible, otherwise surface the controller result. When metaEntry.action=IDLE, do not invoke continuation. Close managed worktree sessions with ${toolNames.closeWorkspace}; it refuses dirty worktrees and removes clean worktrees through Git. When the user explicitly requests one fresh ChatGPT Web conversation with a supplied prompt, invoke web_launch; do not infer this trigger from text typed in another composer. WEB-LAUNCH-0 returns only launch acknowledgement and does not capture assistant output or continue the spawned conversation. When the user explicitly requests one bounded independent PRODUCT or SAW-role review, invoke review_start with exact candidate and evidence manifest bytes plus their SHA-256 digests, retain the returned reviewId, and later invoke review_status with that reviewId. For a post-phase SAW A/B/C gate, invoke saw_review_start once and use saw_review_status with the returned batchId; each reviewer receives an independent fresh-conversation challenge and must not receive another reviewer output. Do not invoke review_submit directly unless the current launched conversation contains the exact REVIEW-RETURN-2 one-time challenge. ${agentsMd}${skills}${inspection}Batch known context reads with ${toolNames.readBatch} to reduce host approval prompts. Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, Git inspection, package scripts, and commands that are better executed by the shell. Shell commands that wait more than ${formatDurationMs(FAST_PATH_QUEUE_WAIT_MS)} for an execution slot, or run more than ${formatDurationMs(FAST_PATH_EXECUTION_MS)} after admission, continue in the background and return an operationId; poll long_task_status to inspect progress or cancel_long_task to terminate them. For commands expected to exceed 60 seconds, you may also invoke start_long_task directly. When the user explicitly requests a commit or push, use publish_git_changes with the existing workspaceId, a workingDirectory relative to the workspace root, and exact file paths. Do not construct /mnt paths, Windows absolute paths, or shell cd commands for workspace navigation; use the workingDirectory field. Do not use ${toolNames.shell} to edit working-tree contents or mutate the Git index, history, remotes, or branches. Avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, generated scripts, or other commands whose purpose is to write project files. Use ${toolNames.edit} or ${toolNames.write} for content changes.${showChanges}`;
}
function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const shellLimiterTelemetryOutputSchema = z.object({
  active: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  activeForWorkspace: z.number().int().nonnegative(),
});

const longTaskDiagnosticsOutputSchema = z.object({
  queueWaitMs: z.number().int().nonnegative().optional(),
  executionMs: z.number().int().nonnegative().optional(),
  totalMs: z.number().int().nonnegative().optional(),
  handoffReason: z.enum(["queue_wait", "execution"]).optional(),
  limiterAtAccept: shellLimiterTelemetryOutputSchema.optional(),
  limiterAtStart: shellLimiterTelemetryOutputSchema.optional(),
});

const longTaskOperationOutputSchema = {
  operationId: z.string(),
  kind: z.enum(["shell", "validation"]),
  workspaceId: z.string(),
  status: z.enum([
    "queued",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  progress: z.string(),
  diagnostics: longTaskDiagnosticsOutputSchema.optional(),
  result: z
    .object({
      output: z.string(),
      taskValidation: nativeTaskValidationOutputSchema.optional(),
    })
    .optional(),
  error: z.string().optional(),
};

function longTaskOperationText(
  operation: LongTaskOperationSnapshot<LongTaskToolResult>,
): string {
  return [
    `Operation: ${operation.operationId}`,
    `Kind: ${operation.kind}`,
    `Status: ${operation.status}`,
    `Progress: ${operation.progress}`,
    diagnosticNumber(operation.diagnostics, "queueWaitMs") !== undefined
      ? `Queue wait: ${diagnosticNumber(operation.diagnostics, "queueWaitMs")}ms`
      : undefined,
    diagnosticNumber(operation.diagnostics, "executionMs") !== undefined
      ? `Execution: ${diagnosticNumber(operation.diagnostics, "executionMs")}ms`
      : undefined,
    operation.result?.output ? `Result:\n${operation.result.output}` : undefined,
    operation.error ? `Error: ${operation.error}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function missingLongTaskOperation(
  operationId: string,
): LongTaskOperationSnapshot<LongTaskToolResult> {
  const now = new Date().toISOString();
  return {
    operationId,
    kind: "shell",
    workspaceId: "unknown",
    status: "failed",
    createdAt: now,
    completedAt: now,
    progress:
      "Operation metadata is unavailable in this DevSpace runtime. It may be stale, evicted, or from a previous runtime.",
    error: "operation_not_found",
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const projectStartupSourceOutputSchema = z.object({
  id: z.string(),
  path: z.string(),
  status: z.enum(["present", "fresh", "stale", "missing", "invalid"]),
  observedAt: z.string().optional(),
});

const projectStartupContextOutputSchema = z.object({
  schemaVersion: z.literal("project-startup-context/v1"),
  status: z.enum(["READY", "BLOCKED"]),
  lines: z.array(z.string()).max(10),
  sources: z.array(projectStartupSourceOutputSchema).max(20),
  blockers: z.array(z.string()).max(10),
});

const metaStartupOutputSchema = z.object({
  status: z.enum(["READY", "BLOCKED", "UNDECLARED", "INSPECTION_FAILED"]),
  lines: z.array(z.string()).max(10),
  blockers: z.array(z.string()).max(10),
});

const metaContinuationOutputSchema = z.object({
  status: z.enum(["READY", "BLOCKED"]),
  blockers: z.array(z.string()).max(10),
});

const metaEntryOutputSchema = z.union([
  z.object({
    schemaVersion: z.literal("meta-entry/v1"),
    action: z.enum(["CONTINUE", "IDLE"]),
    result: z.string().nullable(),
  }),
  z.object({
    schemaVersion: z.literal("meta-entry/v2"),
    action: z.enum(["CONTINUE", "IDLE"]),
    result: z.string().nullable(),
    startupContext: projectStartupContextOutputSchema,
  }),
]);

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  webLaunchBrowser: Pick<WebLaunchBrowserController, "launchWebConversation">,
  metaHarness: MetaHarnessHost = defaultMetaHarnessHost,
  longTaskOperations: LongTaskOperationManager<LongTaskToolResult> = globalLongTaskOperations,
  fastPathTimeoutMs: number = FAST_PATH_EXECUTION_MS,
  sharedControllers?: {
    auditReturnController?: AuditReturnController;
    sourceResolveController?: SourceResolveController;
    reviewReturnController?: ReviewReturnController;
  },
  fastPathQueueWaitMs: number = FAST_PATH_QUEUE_WAIT_MS,
): McpServer {
  const toolNames = toolNamesFor(config);
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: "0.1.0",
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config, toolNames),
    },
  );

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerWebLaunchTool({ server, browser: webLaunchBrowser });

  const auditReturnController =
    sharedControllers?.auditReturnController ?? new AuditReturnController(webLaunchBrowser);
  registerAuditReturnTools({ server, controller: auditReturnController });

  const sourceResolveController =
    sharedControllers?.sourceResolveController ?? new SourceResolveController(webLaunchBrowser);
  registerSourceResolveTools({ server, controller: sourceResolveController });

  const reviewReturnController =
    sharedControllers?.reviewReturnController ??
    new ReviewReturnController(webLaunchBrowser, {
      executionSurface:
        config.chatSessionProvider === "chatshare" ? "chatshare" : "chatgpt_web",
    });
  registerReviewReturnTools({ server, controller: reviewReturnController });

  const workspaceOpenOutputSchema = {
    workspaceId: z.string(),
    root: z.string(),
    mode: z.enum(["checkout", "worktree"]),
    sourceRoot: z.string().optional(),
    worktree: z
      .object({
        path: z.string(),
        baseRef: z.string(),
        baseSha: z.string(),
        branch: z.string().optional(),
        dirtySource: z.boolean(),
        detached: z.boolean(),
        managed: z.boolean(),
      })
      .optional(),
    agentsFiles: z.array(workspaceAgentsFileOutputSchema),
    availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
    skills: z.array(workspaceSkillOutputSchema),
    skillDiagnostics: z.array(z.unknown()),
    metaEntry: metaEntryOutputSchema.optional(),
    metaStartup: metaStartupOutputSchema.optional(),
    metaContinuation: metaContinuationOutputSchema.optional(),
    instruction: z.string(),
  };

  async function openedWorkspaceResponse(
    toolName: "open_workspace" | "create_worktree_workspace",
    request: {
      path: string;
      mode: "checkout" | "worktree";
      baseRef?: string;
      branch?: string;
      createBranch?: boolean;
    },
  ) {
    const startedAt = performance.now();
    const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace(request);
    if (config.widgets === "changes") {
      void reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
    }
    const visibleSkills = workspace.skills
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: formatPathForPrompt(skill.filePath),
      }));
    const loadedAgentsFiles = agentsFiles.map((file) => ({
      path: formatAgentsPath(file.path, workspace.root),
      content: file.content,
    }));
    const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
      path: formatAgentsPath(file.path, workspace.root),
    }));
    let metaEntry: MetaEntry | undefined;
    let metaInspectionFailed = false;
    if (metaHarness.looksLikeRepository(workspace.root)) {
      try {
        metaEntry = await metaHarness.inspectEntry(workspace.root);
      } catch {
        metaInspectionFailed = true;
        metaEntry = {
          schemaVersion: "meta-entry/v1",
          action: "IDLE",
          result: null,
        };
      }
    }
    const baseInstruction = config.skillsEnabled
      ? "Use this workspaceId in all subsequent tool calls for this project. Do not open the same folder again unless this workspaceId stops working, the user asks to reopen, or you intentionally switch folders/worktrees. Follow loaded agentsFiles instructions. Use read_files to load multiple known context or instruction files in one approval; use the single-file read tool only when one file is needed. When a task matches an available skill in skills, read its path before proceeding."
      : "Use this workspaceId in all subsequent tool calls for this project. Do not open the same folder again unless this workspaceId stops working, the user asks to reopen, or you intentionally switch folders/worktrees. Follow loaded agentsFiles instructions. Use read_files to load multiple known context or instruction files in one approval; use the single-file read tool only when one file is needed.";
    const startupContext = metaEntry?.schemaVersion === "meta-entry/v2"
      ? metaEntry.startupContext
      : undefined;
    const metaStartup = metaInspectionFailed
      ? {
          status: "INSPECTION_FAILED" as const,
          lines: [] as string[],
          blockers: ["Meta-Harness inspect failed; startup context was not loaded."],
        }
      : startupContext
        ? {
            status: startupContext.status,
            lines: [...startupContext.lines],
            blockers: [...startupContext.blockers],
          }
        : metaEntry
          ? {
              status: "UNDECLARED" as const,
              lines: [] as string[],
              blockers: ["Meta-Harness inspect returned meta-entry/v1 without repo-declared startup context."],
            }
          : undefined;
    let metaContinuation: MetaContinuationReadiness | undefined;
    if (!metaInspectionFailed
        && metaEntry?.action === "CONTINUE"
        && metaStartup?.status !== "BLOCKED") {
      try {
        metaContinuation = metaHarness.continuationReadiness?.(workspace.root)
          ?? Object.freeze({ status: "READY" as const, blockers: Object.freeze([] as string[]) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        metaContinuation = Object.freeze({
          status: "BLOCKED" as const,
          blockers: Object.freeze([`Meta-Harness continuation readiness check failed: ${message}`]),
        });
      }
    }
    const startupInstruction = metaStartup?.status === "READY"
      ? "Meta-Harness repo-declared startup context is READY. Treat metaStartup.lines as the canonical startup projection before normal work; do not reconstruct project state from chat history or undeclared legacy context files."
      : metaStartup?.status === "BLOCKED"
        ? `Meta-Harness repo-declared startup context is BLOCKED: ${metaStartup.blockers.join("; ") || "declared startup context is incomplete"}. Treat these as recoverable repository-context gaps, not an owner gate. Do not fall back to chat history or undeclared legacy context files.`
        : metaStartup?.status === "UNDECLARED"
          ? "Meta-Harness is detected, but repo-declared startup context is UNDECLARED because inspect returned meta-entry/v1. Do not claim startup context is loaded and do not reconstruct it from chat history or undeclared legacy files. Use continuation only for resume-only intent; a concrete task in the current user turn remains the direct fast path."
          : null;
    const metaInstruction = metaStartup?.status === "BLOCKED"
      ? null
      : metaContinuation?.status === "BLOCKED"
        ? `Meta-Harness automatic continuation is BLOCKED: ${metaContinuation.blockers.join("; ")}. Do not invoke continue_meta_harness and do not synthesize or repair Meta-Harness decision-plane files from DevSpace. Treat this as a recoverable controller-state gap rather than an owner gate.`
        : metaEntry?.action === "CONTINUE" && (metaStartup?.status === "READY" || metaStartup?.status === "UNDECLARED")
          ? "Meta-Harness reports mechanically continuable product work. Velocity-first rule: execute the current user action directly using the startup projection and scoped tools; opening the workspace alone is not resume intent. Invoke continue_meta_harness once only when the user explicitly asks to resume/continue retained Meta-Harness work. Do not automatically retry a STOPPED, BLOCKED, or errored continuation in the same turn."
          : metaInspectionFailed
            ? "Meta-Harness continuation inspection failed. Treat this as a recoverable host diagnostic, not as a product blocker or owner gate. Continue the accepted task through available scoped tools or a fresh supported Meta-Harness route; do not infer internal lifecycle authority."
            : null;
    const instruction = [baseInstruction, startupInstruction, metaInstruction].filter(Boolean).join(" ");
    const startupText = metaStartup
      ? [
          `Meta-Harness startup state: ${metaStartup.status}`,
          ...metaStartup.lines,
          ...(metaStartup.blockers.length > 0
            ? [`Startup blockers: ${metaStartup.blockers.join("; ")}`]
            : []),
        ].join("\n")
      : undefined;
    const continuationText = metaContinuation?.status === "BLOCKED"
      ? [
          "Meta-Harness continuation state: BLOCKED",
          `Continuation blockers: ${metaContinuation.blockers.join("; ")}`,
        ].join("\n")
      : undefined;
    const resultContent: ToolContent[] = [
      {
        type: "text" as const,
        text: [
          `Opened workspace ${workspace.id}`,
          `Root: ${workspace.root}`,
          `Mode: ${workspace.mode}`,
          loadedAgentsFiles.length > 0
            ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
            : undefined,
          availableAgentsFileOutputs.length > 0
            ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
            : undefined,
          visibleSkills.length > 0
            ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
            : undefined,
          startupText,
          continuationText,
          instruction,
        ].filter(Boolean).join("\n"),
      },
    ];
    logToolCall(config, {
      tool: toolName,
      workspaceId: workspace.id,
      path: workspace.root,
      success: true,
      durationMs: Math.round(performance.now() - startedAt),
    });

    return {
      content: resultContent,
      _meta: {
        tool: toolName,
        card: {
          workspaceId: workspace.id,
          root: workspace.root,
          path: workspace.root,
          summary: {
            agentsFiles: loadedAgentsFiles.length,
            availableAgentsFiles: availableAgentsFileOutputs.length,
            skills: visibleSkills.length,
            skillDiagnostics: workspace.skillDiagnostics.length,
          },
        },
      },
      structuredContent: {
        workspaceId: workspace.id,
        root: workspace.root,
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        worktree: workspace.worktree,
        agentsFiles: loadedAgentsFiles,
        availableAgentsFiles: availableAgentsFileOutputs,
        skills: visibleSkills,
        skillDiagnostics: workspace.skillDiagnostics,
        metaEntry,
        metaStartup,
        metaContinuation,
        instruction,
      },
    };
  }

  registerAppTool(
    server,
    toolNames.openWorkspace,
    {
      title: "Open workspace",
      description:
        "Open an existing local project directory or checkout as a coding workspace. This operation does not create the project directory or a Git worktree. For a Meta-Harness repository it may silently complete repository-local init hooks and returns explicit metaStartup and metaContinuation states so missing startup context or non-continuable controller state cannot be mistaken for ready work. Call it once per existing project before normal work, then reuse the returned workspaceId.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to an existing local project directory inside an allowed root.",
          ),
      },
      outputSchema: workspaceOpenOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: OPEN_WORKSPACE_TOOL_ANNOTATIONS,
    },
    async ({ path }) => openedWorkspaceResponse(toolNames.openWorkspace, { path, mode: "checkout" }),
  );

  registerAppTool(
    server,
    toolNames.createWorktreeWorkspace,
    {
      title: "Create worktree workspace",
      description:
        "Create an isolated managed Git worktree and open it as a coding workspace. Use this only when a separate worktree is actually needed; ordinary existing-folder access belongs to open_workspace.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to the existing source Git repository inside an allowed root.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to use for a detached worktree or as the starting point for a new branch. Defaults to HEAD."),
        branch: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Local branch to attach to the managed worktree, or to create when createBranch=true."),
        createBranch: z
          .boolean()
          .optional()
          .describe("Create branch from baseRef before attaching it. Requires branch. Defaults to false."),
      },
      outputSchema: workspaceOpenOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: CREATE_WORKTREE_WORKSPACE_TOOL_ANNOTATIONS,
    },
    async ({ path, baseRef, branch, createBranch }) => openedWorkspaceResponse(
      toolNames.createWorktreeWorkspace,
      { path, mode: "worktree", baseRef, branch, createBranch },
    ),
  );

  registerAppTool(
    server,
    "continue_meta_harness",
    {
      title: "Continue Meta-Harness",
      description:
        "Continue Meta-Harness once against the exact repository root already bound to this workspace. Accepts only workspaceId: no product result, task/session/Claim selector, path, Git ref, model, environment override, or arbitrary command is permitted. A STOPPED or BLOCKED result is terminal for the current automatic attempt; do not retry it automatically in the same user turn.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: resultOutputSchema({
        status: z.enum(["COMPLETED", "STOPPED", "BLOCKED"]),
        exitCode: z.number().int().nullable(),
      }),
      _meta: {},
      annotations: META_CONTINUE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      if (!metaHarness.looksLikeRepository(workspace.root)) {
        throw new Error("continue_meta_harness requires an exact Meta-Harness repository root opened by DevSpace.");
      }
      try {
        const readiness = metaHarness.continuationReadiness?.(workspace.root);
        if (readiness?.status === "BLOCKED") {
          const result = `Meta-Harness continuation blocked: ${readiness.blockers.join("; ")}`;
          logToolCall(config, {
            tool: "continue_meta_harness",
            workspaceId,
            path: workspace.root,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [textBlock(result)],
            structuredContent: { result, status: "BLOCKED" as const, exitCode: null },
          };
        }
        const continuation = await metaHarness.continue(workspace.root);
        const status = continuation.exitCode === 0 ? "COMPLETED" as const : "STOPPED" as const;
        logToolCall(config, {
          tool: "continue_meta_harness",
          workspaceId,
          path: workspace.root,
          success: continuation.exitCode === 0,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(continuation.result)],
          structuredContent: {
            result: continuation.result,
            status,
            exitCode: continuation.exitCode,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logFailedToolResponse(
          config,
          {
            tool: "continue_meta_harness",
            workspaceId,
            path: workspace.root,
          },
          [textBlock(message)],
          startedAt,
        );
        throw error;
      }
    },
  );

  registerAppTool(
    server,
    toolNames.closeWorkspace,
    {
      title: "Close workspace",
      description:
        "Close a workspace session. Checkout sessions are retired without deleting files. Clean managed worktrees are removed through git worktree remove; dirty managed worktrees are refused. If a managed directory is already missing, stale Git metadata is pruned only when Git marks it prunable and pruneStaleMetadata=true is explicitly supplied.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        pruneStaleMetadata: z
          .boolean()
          .optional()
          .describe("Explicitly allow pruning Git-validated stale metadata when the managed worktree directory is already missing. Defaults to false."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        sourceRoot: z.string().optional(),
        mode: z.enum(["checkout", "worktree"]),
        managed: z.boolean(),
        removed: z.boolean(),
        staleMetadataPruned: z.boolean(),
        headSha: z.string().optional(),
        branch: z.string().optional(),
      },
      _meta: {},
      annotations: CLOSE_WORKSPACE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, pruneStaleMetadata }) => {
      const startedAt = performance.now();
      const closed = await workspaces.closeWorkspace({ workspaceId, pruneStaleMetadata });
      reviewCheckpoints.forgetWorkspace(workspaceId);
      logToolCall(config, {
        tool: toolNames.closeWorkspace,
        workspaceId,
        path: closed.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Closed workspace ${workspaceId}`,
              `Root: ${closed.root}`,
              `Mode: ${closed.mode}`,
              closed.removed ? "Managed worktree removed through Git." : undefined,
              closed.staleMetadataPruned ? "Validated stale Git worktree metadata pruned." : undefined,
            ].filter(Boolean).join("\n"),
          },
        ],
        structuredContent: { ...closed },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          `Read one file inside an open workspace. Use ${toolNames.readBatch} instead when two or more known text files are needed, so approval-gated hosts can authorize one bounded call. Use this tool instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.`,
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.readBatch,
    {
      title: "Read files",
      description:
        `Batch-read 1 to ${MAX_BATCH_READ_FILES} known text files or file ranges inside one open workspace. Prefer this over repeated ${toolNames.read} calls when multiple context, instruction, code, or documentation files are already known, especially in approval-gated MCP hosts. Results preserve input order, continue after individual file errors, default to ${DEFAULT_BATCH_READ_LIMIT} lines per file, and cap the combined response at ${MAX_BATCH_READ_CHARACTERS} characters. Images are not supported by this batch tool.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        files: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .describe(
                  config.skillsEnabled
                    ? "Text-file path relative to the workspace root, or an advertised skill path returned by open_workspace."
                    : "Text-file path relative to the workspace root.",
                ),
              offset: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("1-indexed line number to start reading from. Defaults to 1."),
              limit: z
                .number()
                .int()
                .positive()
                .max(MAX_BATCH_READ_LIMIT)
                .optional()
                .describe(
                  `Maximum lines to read from this file. Defaults to ${DEFAULT_BATCH_READ_LIMIT}; maximum ${MAX_BATCH_READ_LIMIT}.`,
                ),
            }),
          )
          .min(1)
          .max(MAX_BATCH_READ_FILES)
          .describe("Known text files or ranges to read in one approval-gated call."),
      },
      outputSchema: resultOutputSchema({
        files: z.array(
          z.object({
            path: z.string(),
            status: z.enum(["ok", "error", "skipped"]),
            offset: z.number().int().positive(),
            limit: z.number().int().positive(),
            charactersReturned: z.number().int().nonnegative(),
            truncated: z.boolean(),
            error: z.string().optional(),
          }),
        ),
        summary: z.object({
          requested: z.number().int().nonnegative(),
          succeeded: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          skipped: z.number().int().nonnegative(),
          characters: z.number().int().nonnegative(),
          truncated: z.boolean(),
        }),
      }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, files }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const result = await readWorkspaceFiles(workspaces, workspace, files);
      const content = [textBlock(result.text)];
      const summary = {
        requested: files.length,
        succeeded: result.succeeded,
        failed: result.failed,
        skipped: result.skipped,
        characters: result.characters,
        truncated: result.truncated,
      };

      logToolCall(config, {
        tool: toolNames.readBatch,
        workspaceId,
        path: files.map((file) => file.path).join(","),
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.readBatch,
          card: {
            workspaceId,
            summary,
            payload: { content },
          },
        },
        structuredContent: {
          result: result.text,
          files: result.files,
          summary,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        allowedRoots: [workspace.root],
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        allowedRoots: [workspace.root],
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show aggregate file changes in an open workspace since the last shown checkpoint or since the workspace was opened. After you create, edit, or overwrite files, call this once when the related file changes are complete so the user can inspect the combined diff.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          since: z
            .enum(["last_shown", "workspace_open"])
            .optional()
            .describe("Defaults to last_shown. Use workspace_open to compare against the initial open_workspace checkpoint."),
          markReviewed: z
            .boolean()
            .optional()
            .describe("Defaults to true. When true, advances the last shown checkpoint to the current workspace state."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: REVIEW_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, since, markReviewed }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: since ?? "last_shown",
          markReviewed: markReviewed ?? true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  registerAppTool(
    server,
    toolNames.grep,
      {
        title: config.toolNaming === "short" ? "Grep" : "Grep files",
        description:
          "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
          allowedRoots: [workspace.root],
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: config.toolNaming === "short" ? "Glob" : "Find files",
        description:
          "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
          allowedRoots: [workspace.root],
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: config.toolNaming === "short" ? "Ls" : "List directory",
        description:
          "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
          allowedRoots: [workspace.root],
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
  );

  registerAppTool(
    server,
    "publish_git_changes",
    {
      title: "Publish Git changes",
      description:
        "Commit exactly the listed files from a private index, leaving any unrelated already-staged files untouched. Do not unstage or reset another slice's index. Run Git whitespace checks, create a normal commit, and optionally push the checked-out branch without force. Use only when the user explicitly requests a commit or push. Pass workingDirectory relative to the opened workspace root; do not construct absolute Windows or /mnt paths and do not run cd commands.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Git repository directory relative to the opened workspace root. Do not pass an absolute path. Defaults to the workspace root.",
          ),
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .describe(
            "Exact file paths to stage, relative to workingDirectory. Directories and broad pathspecs are not accepted as implicit authorization.",
          ),
        message: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe("Commit message for the new normal commit."),
        remote: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Configured Git remote to push to. Defaults to origin."),
        branch: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Target branch. When supplied, it must match the currently checked-out branch.",
          ),
        push: z
          .boolean()
          .optional()
          .describe("Whether to push after committing. Defaults to true."),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, workingDirectory, paths, message, remote, branch, push }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);

      try {
        const result = await publishGitChanges({
          cwd,
          workspaceRoot: workspace.root,
          allowedRoots: [workspace.root],
          paths,
          message,
          remote,
          branch,
          push,
        });
        const resultText = [
          `Created commit ${result.commit} on ${result.branch}.`,
          result.pushed
            ? `Pushed without force to ${result.remote}/${result.branch}.`
            : "Push was not requested.",
          `Published paths: ${result.paths.join(", ")}`,
          result.stat ? `Staged diff summary:\n${result.stat}` : "",
          result.pushOutput ? `Push output:\n${result.pushOutput}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        logToolCall(config, {
          tool: "publish_git_changes",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          path: paths.join(","),
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content: [textBlock(resultText)],
          structuredContent: { result: resultText },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logFailedToolResponse(
          config,
          {
            tool: "publish_git_changes",
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            path: paths.join(","),
          },
          [textBlock(message)],
          startedAt,
        );
        throw error;
      }
    },
  );

  registerAppTool(
    server,
    toolNames.shell,
    {
      title: config.toolNaming === "short" ? "Bash" : "Run shell",
      description:
        `Run a shell command inside an open workspace. Use for tests, builds, Git inspection, package scripts, and commands that genuinely require a shell. Native ${toolNames.read}, ${toolNames.readBatch}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} do not consume shell execution slots; prefer them for file inspection, search, discovery, and directory listing. Use publish_git_changes, not ${toolNames.shell}, when the user explicitly requests staging, commit, or push. Do not use ${toolNames.shell} to edit working-tree file contents or mutate the Git index, history, remotes, or branches. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, generated scripts, or other commands to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Use the workingDirectory field instead of cd or translated absolute paths. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe(
            `Shell command to run for tests, builds, package scripts, and Git inspection. It must not edit working-tree contents or mutate the Git index, history, remotes, or branches. Production runtime control is not granted to this tool: do not invoke setup_devspace.ps1, setup-devspace.ps1, -Stop, or terminate the DevSpace origin/cloudflared/service. Use publish_git_changes for explicitly authorized staging, commit, and push operations, and use ${toolNames.edit} or ${toolNames.write} for content changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema({
        operationId: z
          .string()
          .optional()
          .describe(
            "Background operation ID if command exceeded fast-path timeout.",
          ),
        status: z
          .string()
          .optional()
          .describe(
            "Execution status ('queued', 'running', 'succeeded', 'failed', 'cancelled').",
          ),
        progress: z
          .string()
          .optional()
          .describe("Current progress description."),
        queueWaitMs: z.number().int().nonnegative().optional(),
        executionMs: z.number().int().nonnegative().optional(),
        totalMs: z.number().int().nonnegative().optional(),
        handoffReason: z.enum(["queue_wait", "execution"]).optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }, extra) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );

      if (extra.signal?.aborted) {
        const content = [textBlock("Shell request was cancelled before execution.")];
        logFailedToolResponse(
          config,
          {
            tool: toolNames.shell,
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: input.command,
            commandLength: input.command.length,
          },
          content,
          startedAt,
        );
        return {
          content,
          isError: true,
          structuredContent: {
            result: "Shell request was cancelled before execution.",
            status: "cancelled",
          },
        };
      }

      // 1. Managed from t=0 by LongTaskOperationManager.
      // Public identity is workspaceId; limiter key is workspace.root.
      let markExecutionStarted!: () => void;
      const executionStarted = new Promise<void>((resolve) => {
        markExecutionStarted = resolve;
      });
      const op = longTaskOperations.start(
        "shell",
        workspaceId,
        async (context) => {
          context.updateDiagnostics({
            limiterAtAccept: shellLimiterTelemetry(workspace.root),
          });

          // Managed background work intentionally does not expire in the limiter queue.
          // The synchronous request has its own shorter queue-wait handoff budget below.
          const lease = await globalShellExecutionLimiter.acquire(workspace.root, {
            signal: context.signal,
            queueTimeoutMs: 0,
          });
          const executionStartedAt = performance.now();
          const queueWaitMs = Math.round(executionStartedAt - startedAt);
          context.updateDiagnostics({
            queueWaitMs,
            limiterAtStart: shellLimiterTelemetry(workspace.root),
          });
          context.update("running", `Executing: ${input.command.slice(0, 80)}`);
          markExecutionStarted();

          try {
            const response = await runShellTool(
              input,
              {
                cwd,
                root: workspace.root,
              },
              context.signal,
            );
            const output = contentText(response.content);
            if (response.isError) {
              const error = new Error(output || "Command exited with error");
              (error as any).toolResponse = response;
              throw error;
            }
            return { output, response };
          } finally {
            const completedAt = performance.now();
            context.updateDiagnostics({
              executionMs: Math.round(completedAt - executionStartedAt),
              totalMs: Math.round(completedAt - startedAt),
            });
            lease.release();
          }
        },
      );

      // 2. Client abort ownership:
      // Before async handoff, request abort cancels the managed operation.
      let handedOff = false;
      const onClientAbort = () => {
        if (!handedOff) {
          longTaskOperations.cancel(op.operationId);
        }
      };
      extra.signal?.addEventListener("abort", onClientAbort, { once: true });

      // 3. Fast path has two budgets: queue wait, then execution.
      type FastPathMarker =
        | { fastPathState: "started" }
        | {
            fastPathState: "timeout";
            reason: "queue_wait" | "execution";
          };

      let queueTimeoutId: NodeJS.Timeout | undefined;
      const queueTimeoutPromise = new Promise<FastPathMarker>((resolve) => {
        queueTimeoutId = setTimeout(
          () => resolve({ fastPathState: "timeout", reason: "queue_wait" }),
          fastPathQueueWaitMs,
        );
        queueTimeoutId.unref?.();
      });

      let outcome: LongTaskOperationSnapshot<LongTaskToolResult> | FastPathMarker;
      try {
        outcome = await Promise.race([
          op.completion,
          executionStarted.then(() => ({ fastPathState: "started" }) as const),
          queueTimeoutPromise,
        ]);
      } finally {
        if (queueTimeoutId) clearTimeout(queueTimeoutId);
      }

      if ("fastPathState" in outcome && outcome.fastPathState === "started") {
        let executionTimeoutId: NodeJS.Timeout | undefined;
        const executionTimeoutPromise = new Promise<FastPathMarker>((resolve) => {
          executionTimeoutId = setTimeout(
            () => resolve({ fastPathState: "timeout", reason: "execution" }),
            fastPathTimeoutMs,
          );
          executionTimeoutId.unref?.();
        });
        try {
          outcome = await Promise.race([op.completion, executionTimeoutPromise]);
        } finally {
          if (executionTimeoutId) clearTimeout(executionTimeoutId);
        }
      }

      // Case A: Finished within both fast-path budgets.
      if (!("fastPathState" in outcome)) {
        extra.signal?.removeEventListener("abort", onClientAbort);
        const queueWaitMs = diagnosticNumber(outcome.diagnostics, "queueWaitMs");
        const executionMs = diagnosticNumber(outcome.diagnostics, "executionMs");
        const totalMs = diagnosticNumber(outcome.diagnostics, "totalMs");
        const limiterAtStart = outcome.diagnostics?.limiterAtStart as
          | ShellLimiterTelemetry
          | undefined;

        if (outcome.status === "succeeded" && outcome.result?.response) {
          const response = outcome.result.response;
          const summary = {
            command: input.command,
            workingDirectory: workingDirectory ?? ".",
            queueWaitMs,
            executionMs,
            ...textSummary(response.content),
          };
          logToolCall(config, {
            tool: toolNames.shell,
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: input.command,
            commandLength: input.command.length,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
            queueWaitMs,
            executionMs,
            limiterActive: limiterAtStart?.active,
            limiterQueued: limiterAtStart?.queued,
            limiterActiveForWorkspace: limiterAtStart?.activeForWorkspace,
          });

          return {
            ...response,
            _meta: {
              tool: toolNames.shell,
              card: {
                workspaceId,
                path: workingDirectory,
                summary,
                payload: { content: response.content },
              },
            },
            structuredContent: {
              result: contentText(response.content),
              status: "succeeded",
              queueWaitMs,
              executionMs,
              totalMs,
            },
          };
        }

        const errorMessage = outcome.error || `Command ${outcome.status}`;
        const content = [textBlock(errorMessage)];
        logFailedToolResponse(
          config,
          {
            tool: toolNames.shell,
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: input.command,
            commandLength: input.command.length,
            queueWaitMs,
            executionMs,
            limiterActive: limiterAtStart?.active,
            limiterQueued: limiterAtStart?.queued,
            limiterActiveForWorkspace: limiterAtStart?.activeForWorkspace,
          },
          content,
          startedAt,
        );
        return {
          content,
          isError: true,
          structuredContent: {
            result: errorMessage,
            status: outcome.status,
            queueWaitMs,
            executionMs,
            totalMs,
          },
        };
      }

      // Case B: Queue-wait or execution budget exceeded.
      // Ownership handoff detaches client abort so the operation survives HTTP disconnection.
      handedOff = true;
      extra.signal?.removeEventListener("abort", onClientAbort);
      if (!("fastPathState" in outcome) || outcome.fastPathState !== "timeout") {
        throw new Error("Unexpected shell fast-path marker state after handoff");
      }
      const handoffReason = outcome.reason;
      const elapsedQueueWaitMs =
        handoffReason === "queue_wait"
          ? Math.round(performance.now() - startedAt)
          : undefined;
      longTaskOperations.updateDiagnostics(op.operationId, {
        ...(elapsedQueueWaitMs === undefined ? {} : { queueWaitMs: elapsedQueueWaitMs }),
        handoffReason,
      });

      // Fetch a fresh live snapshot; the snapshot returned by start() is intentionally t=0.
      const freshSnapshot = longTaskOperations.get(op.operationId);
      const queueWaitMs = diagnosticNumber(freshSnapshot.diagnostics, "queueWaitMs");
      const executionMs = diagnosticNumber(freshSnapshot.diagnostics, "executionMs");
      const totalMs = diagnosticNumber(freshSnapshot.diagnostics, "totalMs");
      const limiterAtStart = freshSnapshot.diagnostics?.limiterAtStart as
        | ShellLimiterTelemetry
        | undefined;
      const durationText = formatDurationMs(
        handoffReason === "queue_wait" ? fastPathQueueWaitMs : fastPathTimeoutMs,
      );
      const message =
        (handoffReason === "queue_wait"
          ? `Command waited ${durationText} for a shell execution slot and is continuing in the background.\n`
          : `Command exceeded ${durationText} execution fast-path and is continuing in the background.\n`) +
        `status: ${freshSnapshot.status}\n` +
        `operationId: ${freshSnapshot.operationId}\n\n` +
        `Use long_task_status(operationId: "${freshSnapshot.operationId}") to inspect progress.`;

      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        queueWaitMs,
        executionMs,
        limiterActive: limiterAtStart?.active,
        limiterQueued: limiterAtStart?.queued,
        limiterActiveForWorkspace: limiterAtStart?.activeForWorkspace,
      });

      return {
        content: [textBlock(message)],
        structuredContent: {
          result: message,
          operationId: freshSnapshot.operationId,
          status: freshSnapshot.status,
          progress: freshSnapshot.progress,
          queueWaitMs,
          executionMs,
          totalMs,
          handoffReason,
        },
      };
    },
  );

  registerAppTool(
    server,
    "start_long_task",
    {
      title: "Start long task",
      description:
        "Start shell work or native-task validation asynchronously and return an operationId immediately. Validation without a command returns UNVERIFIED. Results are retained in memory only for the current DevSpace runtime and are not recoverable after runtime restart.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        kind: z
          .enum(["shell", "validation"])
          .describe("Task kind. 'shell' or 'validation'."),
        command: z
          .string()
          .optional()
          .describe("Required for shell tasks; optional for validation tasks."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Optional workspace-relative directory for kind=shell."),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Shell timeout in seconds. Defaults to 300; maximum 300."),
      },
      outputSchema: longTaskOperationOutputSchema,
      _meta: {},
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, kind, command, workingDirectory, timeout }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      let op: LongTaskOperationSnapshot<LongTaskToolResult>;

      if (kind === "shell") {
        const normalizedCommand = command?.trim();
        if (!normalizedCommand) {
          throw new Error("command is required for kind=shell");
        }
        const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);

        op = longTaskOperations.start(
          "shell",
          workspaceId,
          async (context) => {
            const lease = await globalShellExecutionLimiter.acquire(workspace.root, {
              signal: context.signal,
              queueTimeoutMs: 0,
            });
            try {
              context.update("running", `Executing: ${normalizedCommand.slice(0, 80)}`);
              const response = await runShellTool(
                { command: normalizedCommand, timeout: timeout ?? 300 },
                { cwd, root: workspace.root },
                context.signal,
              );
              const output = contentText(response.content);
              if (response.isError) {
                const error = new Error(output || "Command exited with error");
                (error as any).toolResponse = response;
                throw error;
              }
              return { output, response };
            } finally {
              lease.release();
            }
          },
        );
      } else {
        if (workingDirectory !== undefined || timeout !== undefined) {
          throw new Error(
            "workingDirectory and timeout are only valid for kind=shell",
          );
        }
        const normalizedCommand = command?.trim();
        op = longTaskOperations.start(
          "validation",
          workspaceId,
          async (context) => {
            if (normalizedCommand) {
              const lease = await globalShellExecutionLimiter.acquire(workspace.root, {
                signal: context.signal,
                queueTimeoutMs: 0,
              });
              try {
                context.update("running", `Validating: ${normalizedCommand.slice(0, 80)}`);
                const response = await runShellTool(
                  { command: normalizedCommand, timeout: 300 },
                  { cwd: workspace.root, root: workspace.root },
                  context.signal,
                );
                const output = contentText(response.content);
                return {
                  output,
                  response,
                  taskValidation: {
                    taskId: workspaceId,
                    outcome: response.isError ? "BLOCKED" : "DONE",
                    productResult: output,
                    blocker: response.isError ? output : "",
                    completedAt: new Date().toISOString(),
                    validation: [
                      {
                        argv: [normalizedCommand],
                        cwd: workspace.root,
                        passed: !response.isError,
                        exitCode: response.isError ? 1 : 0,
                        durationMs: 0,
                        output,
                      },
                    ],
                  },
                };
              } finally {
                lease.release();
              }
            } else {
              const output = "No validation command declared for workspace.";
              return {
                output,
                taskValidation: {
                  taskId: workspaceId,
                  outcome: "UNVERIFIED",
                  productResult: output,
                  blocker: "No validation command declared",
                  completedAt: new Date().toISOString(),
                  validation: [],
                },
              };
            }
          },
        );
      }

      const text = longTaskOperationText(op);
      logToolCall(config, {
        tool: "start_long_task",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: [textBlock(text)],
        structuredContent: {
          operationId: op.operationId,
          kind: op.kind,
          workspaceId: op.workspaceId,
          status: op.status,
          createdAt: op.createdAt,
          startedAt: op.startedAt,
          completedAt: op.completedAt,
          progress: op.progress,
          diagnostics: op.diagnostics,
          result: op.result
            ? {
                output: op.result.output,
                taskValidation: op.result.taskValidation,
              }
            : undefined,
          error: op.error,
        },
      };
    },
  );

  registerAppTool(
    server,
    "long_task_status",
    {
      title: "Long task status",
      description:
        "Return in-memory progress and terminal output for an operationId. Unknown, evicted, or pre-restart IDs return status=failed with error=operation_not_found.",
      inputSchema: {
        operationId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Operation identifier returned by start_long_task or bash fast-path.",
          ),
      },
      outputSchema: longTaskOperationOutputSchema,
      _meta: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ operationId }) => {
      const startedAt = performance.now();
      const operation =
        longTaskOperations.tryGet(operationId) ?? missingLongTaskOperation(operationId);
      const text = longTaskOperationText(operation);
      logToolCall(config, {
        tool: "long_task_status",
        workspaceId: operation.workspaceId,
        success: operation.error !== "operation_not_found",
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: [textBlock(text)],
        structuredContent: {
          operationId: operation.operationId,
          kind: operation.kind,
          workspaceId: operation.workspaceId,
          status: operation.status,
          createdAt: operation.createdAt,
          startedAt: operation.startedAt,
          completedAt: operation.completedAt,
          progress: operation.progress,
          diagnostics: operation.diagnostics,
          result: operation.result
            ? {
                output: operation.result.output,
                taskValidation: operation.result.taskValidation,
              }
            : undefined,
          error: operation.error,
        },
      };
    },
  );

  registerAppTool(
    server,
    "cancel_long_task",
    {
      title: "Cancel long task",
      description:
        "Cancel a queued or running operation. Terminal operations are unchanged; unknown, evicted, or pre-restart IDs return operation_not_found.",
      inputSchema: {
        operationId: z.string().trim().min(1).describe("Operation identifier to cancel."),
      },
      outputSchema: longTaskOperationOutputSchema,
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operationId }) => {
      const startedAt = performance.now();
      const operation =
        longTaskOperations.tryCancel(operationId) ?? missingLongTaskOperation(operationId);
      const text = longTaskOperationText(operation);
      logToolCall(config, {
        tool: "cancel_long_task",
        workspaceId: operation.workspaceId,
        success: operation.error !== "operation_not_found",
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: [textBlock(text)],
        structuredContent: {
          operationId: operation.operationId,
          kind: operation.kind,
          workspaceId: operation.workspaceId,
          status: operation.status,
          createdAt: operation.createdAt,
          startedAt: operation.startedAt,
          completedAt: operation.completedAt,
          progress: operation.progress,
          diagnostics: operation.diagnostics,
          result: operation.result
            ? {
                output: operation.result.output,
                taskValidation: operation.result.taskValidation,
              }
            : undefined,
          error: operation.error,
        },
      };
    },
  );

  registerAppTool(
    server,
    "safe_rename_file",
    {
      title: "Safe Rename File",
      description:
        "Safely rename or move a regular file to its final location in the workspace.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        sourcePath: z
          .string()
          .describe("Source file path relative to the workspace root."),
        targetPath: z
          .string()
          .describe("Target file path relative to the workspace root."),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, sourcePath, targetPath }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);

      try {
        await safeRenameFile(workspace.root, sourcePath, targetPath);
      } catch (err: unknown) {
        logFailedToolResponse(
          config,
          {
            tool: "safe_rename_file",
            workspaceId,
            path: sourcePath,
          },
          [textBlock(err instanceof Error ? err.message : String(err))],
          startedAt,
        );
        throw err;
      }

      logToolCall(config, {
        tool: "safe_rename_file",
        workspaceId,
        path: sourcePath,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: [
          textBlock(`Successfully renamed ${sourcePath} to ${targetPath}`),
        ],
        _meta: {
          tool: "safe_rename_file",
          card: {
            workspaceId,
            summary: {
              source: sourcePath,
              target: targetPath,
            },
          },
        },
        structuredContent: {
          result: `Successfully renamed ${sourcePath} to ${targetPath}`,
        },
      };
    },
  );

  server.server.oninitialized = () => {
    server.sendToolListChanged();
  };

  return server;
}

function devspaceHostHeaderValidation(allowedHosts: string[]) {
  return (req: Request, res: Response, next: () => void) => {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Missing Host header" },
        id: null,
      });
      return;
    }
    if (!isAllowedHostHeader(hostHeader, allowedHosts)) {
      const hostname = hostHeader.split(":")[0] ?? hostHeader;
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Invalid Host: ${hostname}` },
        id: null,
      });
      return;
    }
    next();
  };
}

export function createServer(
  config = loadConfig(),
  options?: {
    fastPathTimeoutMs?: number;
    fastPathQueueWaitMs?: number;
    longTaskOperations?: LongTaskOperationManager<LongTaskToolResult>;
    mcpTransportMode?: McpTransportMode;
    maxMcpSessions?: number;
    mcpSessionIdleMs?: number;
  },
): RunningServer {
  const app = express();
  app.use(express.json());
  if (!config.allowedHosts.includes("*")) {
    const allowedHosts = Array.from(new Set([config.host, ...config.allowedHosts]));
    app.use(devspaceHostHeaderValidation(allowedHosts));
  }
  const transports = new Map<string, Transport>();
  const transportActivity = new Map<string, { lastSeenMs: number; inFlight: number }>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const webLaunchBrowser = new WebLaunchBrowserController(config.allowedRoots, {
    sessionProvider: config.chatSessionProvider,
    devSpacePublicBaseUrl: config.publicBaseUrl,
  });
  const executionSurface =
    config.chatSessionProvider === "chatshare" ? "chatshare" : "chatgpt_web";
  const auditReturnController = new AuditReturnController(webLaunchBrowser, { executionSurface });
  const sourceResolveController = new SourceResolveController(webLaunchBrowser, {
    executionSurface,
    cleanupSucceededConversations: executionSurface === "chatshare",
  });
  const reviewReturnController = new ReviewReturnController(webLaunchBrowser, {
    executionSurface,
  });
  const mcpTransportMode =
    options?.mcpTransportMode ?? resolveMcpTransportMode(process.env.DEVSPACE_MCP_TRANSPORT_MODE);
  const maxMcpSessions = options?.maxMcpSessions ?? MAX_MCP_SESSIONS;
  const mcpSessionIdleMs = options?.mcpSessionIdleMs ?? MCP_SESSION_IDLE_MS;
  const makeMcpServer = () =>
    createMcpServer(
      config,
      workspaces,
      reviewCheckpoints,
      webLaunchBrowser,
      defaultMetaHarnessHost,
      options?.longTaskOperations ?? globalLongTaskOperations,
      options?.fastPathTimeoutMs ?? FAST_PATH_EXECUTION_MS,
      {
        auditReturnController,
        sourceResolveController,
        reviewReturnController,
      },
      options?.fastPathQueueWaitMs ?? FAST_PATH_QUEUE_WAIT_MS,
    );

  if (config.logging.trustProxy) {
    app.set("trust proxy", () => true);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  const issuerUrl = new URL(config.publicBaseUrl);
  const oauthMetadata = createOAuthMetadata({
    provider: oauthProvider,
    issuerUrl,
    baseUrl: issuerUrl,
    scopesSupported: config.oauth.scopes,
  });
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );
  // Chatshare's connector backend probes OIDC discovery after /token.
  // MCP already serves RFC 8414 metadata; alias it so a 404 is not treated as
  // "we couldn't connect your account."
  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(oauthMetadata);
  });

  // RFC 9728: some clients probe the bare resource metadata URL (without the
  // /mcp path suffix). Redirect them to the canonical suffixed form so they
  // can complete OAuth discovery instead of treating a 404 as "unidentified."
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.redirect(301, "/.well-known/oauth-protected-resource/mcp");
  });

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (req.auth?.resource && !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
      transportMode: mcpTransportMode,
    });

    if (mcpTransportMode === "stateless") {
      if (req.method !== "POST") {
        sendJsonRpcError(res, 405, -32000, "Method not allowed");
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = makeMcpServer();
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        void server.close().catch((error) => {
          logEvent(config.logging, "warn", "mcp_stateless_cleanup_error", {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      };
      res.once("finish", cleanup);
      res.once("close", cleanup);

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        cleanup();
        logEvent(config.logging, "error", "mcp_request_error", {
          requestId,
          transportMode: mcpTransportMode,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal server error");
        }
      }
      return;
    }

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        if (transports.size >= maxMcpSessions) {
          const now = Date.now();
          const stale = [...transportActivity.entries()]
            .filter(
              ([, activity]) =>
                activity.inFlight === 0 && now - activity.lastSeenMs >= mcpSessionIdleMs,
            )
            .sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs)[0];
          if (stale) {
            logEvent(config.logging, "info", "mcp_session_reap", {
              requestId,
              reason: "capacity_stale",
              sessionIdPrefix: sessionIdPrefix(stale[0]),
              idleMs: now - stale[1].lastSeenMs,
            });
            await transports.get(stale[0])?.close().catch(() => undefined);
          }
          if (transports.size >= maxMcpSessions) {
            sendJsonRpcError(
              res,
              503,
              -32002,
              `DevSpace is at the MCP session limit (${maxMcpSessions}). Close an idle client session and retry.`,
            );
            return;
          }
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
            transportActivity.set(newSessionId, { lastSeenMs: Date.now(), inFlight: 0 });
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
            transportActivity.delete(closedSessionId);
            logEvent(config.logging, "info", "mcp_session_closed", {
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = makeMcpServer();
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      const activitySessionId = sessionId ?? transport.sessionId;
      const activity = activitySessionId ? transportActivity.get(activitySessionId) : undefined;
      if (activity) {
        activity.inFlight += 1;
        activity.lastSeenMs = Date.now();
      }
      try {
        await transport.handleRequest(req, res, req.body);
      } finally {
        const completedSessionId = activitySessionId ?? transport.sessionId;
        const completed = completedSessionId ? transportActivity.get(completedSessionId) : undefined;
        if (completed) {
          completed.inFlight = Math.max(0, completed.inFlight - 1);
          completed.lastSeenMs = Date.now();
        }
      }
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, activity] of transportActivity) {
      if (activity.inFlight > 0 || now - activity.lastSeenMs < mcpSessionIdleMs) continue;
      const transport = transports.get(sessionId);
      if (!transport) {
        transportActivity.delete(sessionId);
        continue;
      }
      logEvent(config.logging, "info", "mcp_session_reap", {
        reason: "idle_timeout",
        sessionIdPrefix: sessionIdPrefix(sessionId),
        idleMs: now - activity.lastSeenMs,
      });
      void transport.close().catch((error) => {
        logEvent(config.logging, "warn", "mcp_session_reap_error", {
          sessionIdPrefix: sessionIdPrefix(sessionId),
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const evicted = workspaces.evictInactiveMemory(WORKSPACE_MEMORY_IDLE_MS, now);
    for (const workspaceId of evicted) reviewCheckpoints.forgetWorkspace(workspaceId);
    if (evicted.length > 0) {
      logEvent(config.logging, "debug", "workspace_memory_reaped", { evicted: evicted.length });
    }
  }, REAPER_INTERVAL_MS);
  reaper.unref?.();

  let closed = false;
  return {
    app,
    config,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(reaper);
      killTrackedShellProcesses();
      await Promise.allSettled([...transports.values()].map((transport) => transport.close()));
      transports.clear();
      transportActivity.clear();
      reviewReturnController.close();
      await webLaunchBrowser.close();
      oauthProvider.close();
      workspaceStore.close?.();
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(
      config.oauth.deviceAuthorization.required
        ? "auth: enrolled-PC device proof required"
        : "auth: enrolled-PC proof for configured callbacks; owner approval otherwise",
    );
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
  });

  const shutdown = () => {
    killTrackedShellProcesses();
    httpServer.close(() => {
      void close().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

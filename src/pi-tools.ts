import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { assertCanonicalReadPath, resolveAllowedPath } from "./roots.js";
import { evaluateBashRuntimePolicy, loadRuntimePolicyContext } from "./bash-runtime-policy.js";
import { resolveWorkspaceShell, type WorkspaceShellKind } from "./workspace-shell.js";
import { createGuardedBashOperations } from "./shell-runtime.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  allowedRoots?: string[];
  readRoots?: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const readRoots = context.readRoots ?? [context.root];
  const path = resolveAllowedPath(input.path, context.cwd, readRoots);
  await assertCanonicalReadPath(path, readRoots);
  const tool = createReadTool(context.cwd);

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.allowedRoots ?? [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, context.allowedRoots ?? [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(
  input: GrepToolInput & { include?: string },
  context: ToolContext,
): Promise<ToolResponse> {
  if (input.path) {
    const roots = context.allowedRoots ?? [context.root];
    const path = resolveAllowedPath(input.path, context.cwd, roots);
    await assertCanonicalReadPath(path, roots);
  }
  const tool = createGrepTool(context.cwd);
  const { include, ...rest } = input;

  return runTool((params) => tool.execute("grep_files", params), {
    ...rest,
    glob: rest.glob ?? include,
  }, context);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) {
    const roots = context.allowedRoots ?? [context.root];
    const path = resolveAllowedPath(input.path, context.cwd, roots);
    await assertCanonicalReadPath(path, roots);
  }
  const tool = createFindTool(context.cwd);

  return runTool((params) => tool.execute("find_files", params), input, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) {
    const roots = context.allowedRoots ?? [context.root];
    const path = resolveAllowedPath(input.path, context.cwd, roots);
    await assertCanonicalReadPath(path, roots);
  }
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), input, context);
}

function shellCommand(command: string, kind: WorkspaceShellKind): string {
  if (process.platform !== "win32" || kind === "wsl-bash") return command;

  return `git() { command git.exe "$@"; }\n${command}`;
}

export async function runShellTool(
  input: BashToolInput,
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResponse> {
  const policy = evaluateBashRuntimePolicy(input.command, loadRuntimePolicyContext());
  if (!policy.allowed) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Denied ${policy.capability}: ${policy.reason ?? "command is not granted to MCP bash."}`,
        },
      ],
    };
  }

  const workspaceShell = resolveWorkspaceShell();
  const tool = createBashTool(context.cwd, {
    shellPath: workspaceShell.shellPath,
    operations: createGuardedBashOperations(workspaceShell),
  });
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  try {
    const result = await tool.execute("run_shell", {
      command: shellCommand(input.command, workspaceShell.kind),
      timeout,
    }, signal);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

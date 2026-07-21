import { readFileTool } from "./pi-tools.js";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";

export const MAX_BATCH_READ_FILES = 20;
export const DEFAULT_BATCH_READ_LIMIT = 400;
export const MAX_BATCH_READ_LIMIT = 2_000;
export const MAX_BATCH_READ_CHARACTERS = 120_000;

export interface BatchReadRequest {
  path: string;
  offset?: number;
  limit?: number;
}

export type BatchReadStatus = "ok" | "error" | "skipped";

export interface BatchReadFileResult {
  path: string;
  status: BatchReadStatus;
  offset: number;
  limit: number;
  charactersReturned: number;
  truncated: boolean;
  error?: string;
}

export interface BatchReadResult {
  text: string;
  files: BatchReadFileResult[];
  succeeded: number;
  failed: number;
  skipped: number;
  characters: number;
  truncated: boolean;
}

export interface BatchReadOptions {
  maxCharacters?: number;
}

function contentText(
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >,
): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function displayPath(path: string): string {
  return path.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function validateRequest(request: BatchReadRequest): {
  offset: number;
  limit: number;
} {
  const offset = request.offset ?? 1;
  const limit = request.limit ?? DEFAULT_BATCH_READ_LIMIT;

  if (!Number.isInteger(offset) || offset < 1) {
    throw new Error(`Batch read offset must be a positive integer: ${request.path}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_READ_LIMIT) {
    throw new Error(
      `Batch read limit must be between 1 and ${MAX_BATCH_READ_LIMIT}: ${request.path}`,
    );
  }

  return { offset, limit };
}

function appendSection(
  current: string,
  heading: string,
  body: string,
  maxCharacters: number,
): { text: string; charactersReturned: number; truncated: boolean } {
  const separator = current.length > 0 ? "\n\n" : "";
  const prefix = `${separator}===== FILE: ${heading} =====\n`;
  const remaining = maxCharacters - current.length;

  if (remaining <= prefix.length) {
    return { text: current, charactersReturned: 0, truncated: true };
  }

  const availableBodyCharacters = remaining - prefix.length;
  if (body.length <= availableBodyCharacters) {
    return {
      text: `${current}${prefix}${body}`,
      charactersReturned: body.length,
      truncated: false,
    };
  }

  const marker = "\n[TRUNCATED: batch character limit reached]";
  const bodyBudget = Math.max(0, availableBodyCharacters - marker.length);
  const clippedBody = `${body.slice(0, bodyBudget)}${marker.slice(
    0,
    availableBodyCharacters - bodyBudget,
  )}`;

  return {
    text: `${current}${prefix}${clippedBody}`,
    charactersReturned: clippedBody.length,
    truncated: true,
  };
}

export async function readWorkspaceFiles(
  registry: WorkspaceRegistry,
  workspace: Workspace,
  requests: BatchReadRequest[],
  options: BatchReadOptions = {},
): Promise<BatchReadResult> {
  if (requests.length === 0) {
    throw new Error("At least one file is required for a batch read");
  }
  if (requests.length > MAX_BATCH_READ_FILES) {
    throw new Error(
      `A batch read accepts at most ${MAX_BATCH_READ_FILES} files`,
    );
  }

  const maxCharacters = options.maxCharacters ?? MAX_BATCH_READ_CHARACTERS;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("Batch read maxCharacters must be a positive integer");
  }

  let text = "";
  let outputTruncated = false;
  const files: BatchReadFileResult[] = [];

  for (const request of requests) {
    const { offset, limit } = validateRequest(request);

    if (outputTruncated) {
      files.push({
        path: request.path,
        status: "skipped",
        offset,
        limit,
        charactersReturned: 0,
        truncated: false,
        error: "Skipped because the batch character limit was reached",
      });
      continue;
    }

    try {
      const readPath = registry.resolveReadPath(workspace, request.path);
      const response = await readFileTool(
        {
          path: readPath.absolutePath,
          offset,
          limit,
        },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        throw new Error(contentText(response.content) || "File read failed");
      }
      if (response.content.some((item) => item.type !== "text")) {
        throw new Error(
          "read_files supports text context only; use the single-file read tool for images",
        );
      }

      registry.markReadPathLoaded(workspace, readPath);
      const fileText = contentText(response.content);
      const appended = appendSection(
        text,
        displayPath(request.path),
        fileText.length > 0 ? fileText : "[empty file]",
        maxCharacters,
      );
      text = appended.text;
      outputTruncated = appended.truncated;
      files.push({
        path: request.path,
        status: "ok",
        offset,
        limit,
        charactersReturned: appended.charactersReturned,
        truncated: appended.truncated,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorBody = `[ERROR] ${message.slice(0, 2_000)}`;
      const appended = appendSection(
        text,
        displayPath(request.path),
        errorBody,
        maxCharacters,
      );
      text = appended.text;
      outputTruncated = appended.truncated;
      files.push({
        path: request.path,
        status: "error",
        offset,
        limit,
        charactersReturned: appended.charactersReturned,
        truncated: appended.truncated,
        error: message,
      });
    }
  }

  const succeeded = files.filter((file) => file.status === "ok").length;
  const failed = files.filter((file) => file.status === "error").length;
  const skipped = files.filter((file) => file.status === "skipped").length;

  return {
    text,
    files,
    succeeded,
    failed,
    skipped,
    characters: text.length,
    truncated: outputTruncated,
  };
}

import { eq } from "drizzle-orm";
import type { NativeTaskOutcome } from "./native-task.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  nativeTasks,
  workspaceSessions,
  type NativeTaskRow,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  headSha?: string;
  branch?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface NativeTaskRecord {
  taskId: string;
  taskDigest: string;
  briefJson: string;
  workspaceId: string;
  outcome: NativeTaskOutcome;
  latestValidationJson?: string;
  gitCustodyJson?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    headSha?: string;
    branch?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  closeSession(id: string, headSha?: string): void;
  createTask(input: Omit<NativeTaskRecord, "createdAt" | "updatedAt">): NativeTaskRecord;
  getTask(taskId: string): NativeTaskRecord | undefined;
  getTaskForWorkspace(workspaceId: string): NativeTaskRecord | undefined;
  updateTaskResult(input: {
    taskId: string;
    outcome: NativeTaskOutcome;
    latestValidationJson?: string;
    gitCustodyJson?: string;
  }): void;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    headSha?: string;
    branch?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      headSha: input.headSha ?? input.baseSha,
      branch: input.branch,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        headSha: session.headSha ?? null,
        branch: session.branch ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  closeSession(id: string, headSha?: string): void {
    const values: { status: string; lastUsedAt: string; headSha?: string } = {
      status: "closed",
      lastUsedAt: new Date().toISOString(),
    };
    if (headSha) values.headSha = headSha;

    this.database.db
      .update(workspaceSessions)
      .set(values)
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  createTask(input: Omit<NativeTaskRecord, "createdAt" | "updatedAt">): NativeTaskRecord {
    const now = new Date().toISOString();
    const task: NativeTaskRecord = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.database.db
      .insert(nativeTasks)
      .values({
        taskId: task.taskId,
        taskDigest: task.taskDigest,
        briefJson: task.briefJson,
        workspaceId: task.workspaceId,
        outcome: task.outcome,
        latestValidationJson: task.latestValidationJson ?? null,
        gitCustodyJson: task.gitCustodyJson ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })
      .run();
    return task;
  }

  getTask(taskId: string): NativeTaskRecord | undefined {
    const row = this.database.db
      .select()
      .from(nativeTasks)
      .where(eq(nativeTasks.taskId, taskId))
      .get();
    return row ? rowToNativeTaskRecord(row) : undefined;
  }

  getTaskForWorkspace(workspaceId: string): NativeTaskRecord | undefined {
    const row = this.database.db
      .select()
      .from(nativeTasks)
      .where(eq(nativeTasks.workspaceId, workspaceId))
      .get();
    return row ? rowToNativeTaskRecord(row) : undefined;
  }

  updateTaskResult(input: {
    taskId: string;
    outcome: NativeTaskOutcome;
    latestValidationJson?: string;
    gitCustodyJson?: string;
  }): void {
    this.database.db
      .update(nativeTasks)
      .set({
        outcome: input.outcome,
        latestValidationJson: input.latestValidationJson ?? null,
        gitCustodyJson: input.gitCustodyJson ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(nativeTasks.taskId, input.taskId))
      .run();
  }

  close(): void {
    this.database.close();
  }
}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    headSha: row.headSha ?? undefined,
    branch: row.branch ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToNativeTaskRecord(row: NativeTaskRow): NativeTaskRecord {
  if (!(["READY", "DONE", "UNVERIFIED", "BLOCKED"] as const).includes(row.outcome as NativeTaskOutcome)) {
    throw new Error(`Persisted task ${row.taskId} has invalid outcome: ${row.outcome}`);
  }
  return {
    taskId: row.taskId,
    taskDigest: row.taskDigest,
    briefJson: row.briefJson,
    workspaceId: row.workspaceId,
    outcome: row.outcome as NativeTaskOutcome,
    latestValidationJson: row.latestValidationJson ?? undefined,
    gitCustodyJson: row.gitCustodyJson ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

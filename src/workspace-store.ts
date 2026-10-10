import { eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  sessionArtifacts,
  sessionGitBaselines,
  workspaceSessions,
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

export interface SessionArtifact {
  workspaceSessionId: string;
  repositoryRoot: string;
  path: string;
  expectedSha256: string | null;
  state: "pending" | "ready" | "unsafe" | "excluded";
  reason: string | null;
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
  getArtifact(id: string, repositoryRoot: string, path: string): SessionArtifact | undefined;
  putArtifact(artifact: SessionArtifact): void;
  listArtifacts(id: string): SessionArtifact[];
  putBaseline(id: string, repositoryRoot: string | null, snapshot: Record<string, string>): void;
  getBaseline(id: string): { repositoryRoot: string | null; snapshot: Record<string, string> } | undefined;
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

  getArtifact(id: string, repositoryRoot: string, path: string): SessionArtifact | undefined {
    const row = this.database.db.select().from(sessionArtifacts).where(
      eq(sessionArtifacts.workspaceSessionId, id),
    ).all().find((entry) => entry.repositoryRoot === repositoryRoot && entry.path === path);
    return row ? artifactFromRow(row) : undefined;
  }

  putArtifact(artifact: SessionArtifact): void {
    this.database.db.insert(sessionArtifacts).values({
      ...artifact,
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [sessionArtifacts.workspaceSessionId, sessionArtifacts.repositoryRoot, sessionArtifacts.path],
      set: {
        expectedSha256: artifact.expectedSha256,
        state: artifact.state,
        reason: artifact.reason,
        updatedAt: new Date().toISOString(),
      },
    }).run();
  }

  listArtifacts(id: string): SessionArtifact[] {
    return this.database.db.select().from(sessionArtifacts)
      .where(eq(sessionArtifacts.workspaceSessionId, id)).all().map(artifactFromRow);
  }

  putBaseline(id: string, repositoryRoot: string | null, snapshot: Record<string, string>): void {
    this.database.db.insert(sessionGitBaselines).values({
      workspaceSessionId: id,
      repositoryRoot,
      statusJson: JSON.stringify(snapshot),
    }).onConflictDoUpdate({
      target: sessionGitBaselines.workspaceSessionId,
      set: { repositoryRoot, statusJson: JSON.stringify(snapshot) },
    }).run();
  }

  getBaseline(id: string): { repositoryRoot: string | null; snapshot: Record<string, string> } | undefined {
    const row = this.database.db.select().from(sessionGitBaselines)
      .where(eq(sessionGitBaselines.workspaceSessionId, id)).get();
    return row ? { repositoryRoot: row.repositoryRoot, snapshot: JSON.parse(row.statusJson) } : undefined;
  }

  close(): void {
    this.database.close();
  }
}

function artifactFromRow(row: typeof sessionArtifacts.$inferSelect): SessionArtifact {
  return {
    workspaceSessionId: row.workspaceSessionId,
    repositoryRoot: row.repositoryRoot,
    path: row.path,
    expectedSha256: row.expectedSha256,
    state: row.state as SessionArtifact["state"],
    reason: row.reason,
  };
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

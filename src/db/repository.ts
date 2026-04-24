import type Database from "better-sqlite3";
import {
  INBOX_RETENTION_MS,
  LOCK_DEFAULT_TTL_MS,
  SESSION_TTL_MS,
} from "./schema.js";
import type { InboxRow, ResourceLockRow, SessionRow } from "./index.js";

export interface RegisterSessionInput {
  id: string;
  project: string;
  branch?: string | null;
  intent?: string | null;
  pid?: number | null;
  hostname?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ClaimResult {
  ok: boolean;
  lock?: ResourceLockRow;
  held_by?: ResourceLockRow;
}

export class Repository {
  constructor(private readonly db: Database.Database) {}

  now(): number {
    return Date.now();
  }

  pruneDeadSessions(): number {
    const cutoff = this.now() - SESSION_TTL_MS;
    const stmt = this.db.prepare(
      "DELETE FROM sessions WHERE last_heartbeat < ?",
    );
    return stmt.run(cutoff).changes;
  }

  pruneExpiredLocks(): number {
    const stmt = this.db.prepare(
      "DELETE FROM resource_locks WHERE expires_at < ?",
    );
    return stmt.run(this.now()).changes;
  }

  pruneOldInbox(): number {
    const cutoff = this.now() - INBOX_RETENTION_MS;
    const stmt = this.db.prepare("DELETE FROM inbox WHERE created_at < ?");
    return stmt.run(cutoff).changes;
  }

  pruneAll(): void {
    this.pruneDeadSessions();
    this.pruneExpiredLocks();
    this.pruneOldInbox();
  }

  registerSession(input: RegisterSessionInput): SessionRow {
    const now = this.now();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, project, branch, intent, pid, hostname, started_at, last_heartbeat, metadata)
      VALUES (@id, @project, @branch, @intent, @pid, @hostname, @started_at, @last_heartbeat, @metadata)
      ON CONFLICT(id) DO UPDATE SET
        project = excluded.project,
        branch = excluded.branch,
        intent = excluded.intent,
        pid = excluded.pid,
        hostname = excluded.hostname,
        last_heartbeat = excluded.last_heartbeat,
        metadata = excluded.metadata
    `);
    stmt.run({
      id: input.id,
      project: input.project,
      branch: input.branch ?? null,
      intent: input.intent ?? null,
      pid: input.pid ?? null,
      hostname: input.hostname ?? null,
      started_at: now,
      last_heartbeat: now,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    });
    return this.getSession(input.id)!;
  }

  heartbeat(sessionId: string): boolean {
    const stmt = this.db.prepare(
      "UPDATE sessions SET last_heartbeat = ? WHERE id = ?",
    );
    return stmt.run(this.now(), sessionId).changes > 0;
  }

  unregisterSession(sessionId: string): boolean {
    const stmt = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    return stmt.run(sessionId).changes > 0;
  }

  getSession(sessionId: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
  }

  listSessions(project?: string): SessionRow[] {
    this.pruneDeadSessions();
    if (project) {
      return this.db
        .prepare(
          "SELECT * FROM sessions WHERE project = ? ORDER BY started_at ASC",
        )
        .all(project) as SessionRow[];
    }
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY project, started_at ASC")
      .all() as SessionRow[];
  }

  claimResource(input: {
    resource: string;
    project: string;
    session_id: string;
    branch?: string | null;
    reason?: string | null;
    ttl_seconds?: number;
  }): ClaimResult {
    this.pruneExpiredLocks();
    const now = this.now();
    const ttlMs = (input.ttl_seconds ?? LOCK_DEFAULT_TTL_MS / 1000) * 1000;
    const expires_at = now + ttlMs;

    const existing = this.db
      .prepare(
        "SELECT * FROM resource_locks WHERE project = ? AND resource = ?",
      )
      .get(input.project, input.resource) as ResourceLockRow | undefined;

    if (existing && existing.session_id !== input.session_id) {
      return { ok: false, held_by: existing };
    }

    const stmt = this.db.prepare(`
      INSERT INTO resource_locks (resource, project, session_id, branch, reason, acquired_at, expires_at)
      VALUES (@resource, @project, @session_id, @branch, @reason, @acquired_at, @expires_at)
      ON CONFLICT(project, resource) DO UPDATE SET
        session_id = excluded.session_id,
        branch = excluded.branch,
        reason = excluded.reason,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
    `);
    stmt.run({
      resource: input.resource,
      project: input.project,
      session_id: input.session_id,
      branch: input.branch ?? null,
      reason: input.reason ?? null,
      acquired_at: existing ? existing.acquired_at : now,
      expires_at,
    });

    const lock = this.db
      .prepare(
        "SELECT * FROM resource_locks WHERE project = ? AND resource = ?",
      )
      .get(input.project, input.resource) as ResourceLockRow;

    return { ok: true, lock };
  }

  releaseResource(input: {
    resource: string;
    project: string;
    session_id: string;
    force?: boolean;
  }): { released: boolean; reason?: string } {
    const existing = this.db
      .prepare(
        "SELECT * FROM resource_locks WHERE project = ? AND resource = ?",
      )
      .get(input.project, input.resource) as ResourceLockRow | undefined;

    if (!existing) return { released: false, reason: "not_held" };
    if (existing.session_id !== input.session_id && !input.force) {
      return { released: false, reason: "not_owner" };
    }

    this.db
      .prepare(
        "DELETE FROM resource_locks WHERE project = ? AND resource = ?",
      )
      .run(input.project, input.resource);
    return { released: true };
  }

  listLocks(project?: string): ResourceLockRow[] {
    this.pruneExpiredLocks();
    if (project) {
      return this.db
        .prepare(
          "SELECT * FROM resource_locks WHERE project = ? ORDER BY acquired_at ASC",
        )
        .all(project) as ResourceLockRow[];
    }
    return this.db
      .prepare("SELECT * FROM resource_locks ORDER BY project, acquired_at ASC")
      .all() as ResourceLockRow[];
  }

  broadcast(input: {
    project: string;
    from_session: string;
    from_branch?: string | null;
    message: string;
    tags?: string[] | null;
  }): InboxRow {
    this.pruneOldInbox();
    const stmt = this.db.prepare(`
      INSERT INTO inbox (project, from_session, from_branch, message, tags, created_at)
      VALUES (@project, @from_session, @from_branch, @message, @tags, @created_at)
    `);
    const result = stmt.run({
      project: input.project,
      from_session: input.from_session,
      from_branch: input.from_branch ?? null,
      message: input.message,
      tags: input.tags ? JSON.stringify(input.tags) : null,
      created_at: this.now(),
    });
    return this.db
      .prepare("SELECT * FROM inbox WHERE id = ?")
      .get(result.lastInsertRowid) as InboxRow;
  }

  readInbox(input: {
    project: string;
    session_id: string;
    unread_only?: boolean;
    limit?: number;
  }): InboxRow[] {
    this.pruneOldInbox();
    const limit = input.limit ?? 50;
    let rows: InboxRow[];

    if (input.unread_only) {
      rows = this.db
        .prepare(
          `
          SELECT i.* FROM inbox i
          LEFT JOIN inbox_reads r
            ON r.message_id = i.id AND r.session_id = ?
          WHERE i.project = ? AND r.message_id IS NULL AND i.from_session != ?
          ORDER BY i.created_at DESC
          LIMIT ?
        `,
        )
        .all(
          input.session_id,
          input.project,
          input.session_id,
          limit,
        ) as InboxRow[];
    } else {
      rows = this.db
        .prepare(
          `
          SELECT * FROM inbox
          WHERE project = ? AND from_session != ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
        )
        .all(input.project, input.session_id, limit) as InboxRow[];
    }

    if (rows.length > 0) {
      const markStmt = this.db.prepare(
        "INSERT OR IGNORE INTO inbox_reads (session_id, message_id, read_at) VALUES (?, ?, ?)",
      );
      const now = this.now();
      const tx = this.db.transaction((messages: InboxRow[]) => {
        for (const m of messages) markStmt.run(input.session_id, m.id, now);
      });
      tx(rows);
    }

    return rows;
  }
}

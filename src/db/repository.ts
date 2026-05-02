import type Database from "better-sqlite3";
import {
  INBOX_RETENTION_MS,
  LOCK_DEFAULT_TTL_MS,
  SESSION_TTL_MS,
} from "./schema.js";
import type {
  InboxPriority,
  InboxRow,
  ResourceLockRow,
  SessionRow,
} from "./index.js";

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
  session_recreated?: boolean;
}

export interface HeartbeatResult {
  ok: boolean;
  reason?: "session_not_found";
  advice?: string;
  recreated?: boolean;
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

  heartbeat(
    sessionId: string,
    recreateWith?: RegisterSessionInput,
  ): HeartbeatResult {
    const stmt = this.db.prepare(
      "UPDATE sessions SET last_heartbeat = ? WHERE id = ?",
    );
    const updated = stmt.run(this.now(), sessionId).changes > 0;
    if (updated) return { ok: true };

    if (recreateWith && recreateWith.id === sessionId) {
      this.registerSession(recreateWith);
      return { ok: true, recreated: true };
    }
    return {
      ok: false,
      reason: "session_not_found",
      advice:
        "Session was pruned (TTL expired) or never registered. Call session_register to re-create it.",
    };
  }

  unregisterSession(sessionId: string): { removed: boolean; reason?: string } {
    const changes = this.db
      .prepare("DELETE FROM sessions WHERE id = ?")
      .run(sessionId).changes;
    if (changes > 0) return { removed: true };
    return { removed: false, reason: "session_not_found" };
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

    let sessionRecreated = false;
    if (!this.getSession(input.session_id)) {
      this.registerSession({
        id: input.session_id,
        project: input.project,
        branch: input.branch ?? null,
      });
      sessionRecreated = true;
    }

    const existing = this.db
      .prepare(
        "SELECT * FROM resource_locks WHERE project = ? AND resource = ?",
      )
      .get(input.project, input.resource) as ResourceLockRow | undefined;

    if (existing && existing.session_id !== input.session_id) {
      return {
        ok: false,
        held_by: existing,
        session_recreated: sessionRecreated || undefined,
      };
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

    return {
      ok: true,
      lock,
      session_recreated: sessionRecreated || undefined,
    };
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
    to_session?: string | null;
    priority?: InboxPriority | null;
    message: string;
    tags?: string[] | null;
  }): InboxRow {
    this.pruneOldInbox();
    const stmt = this.db.prepare(`
      INSERT INTO inbox (project, from_session, from_branch, to_session, priority, message, tags, created_at)
      VALUES (@project, @from_session, @from_branch, @to_session, @priority, @message, @tags, @created_at)
    `);
    const result = stmt.run({
      project: input.project,
      from_session: input.from_session,
      from_branch: input.from_branch ?? null,
      to_session: input.to_session ?? null,
      priority: input.priority ?? "info",
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
    peek?: boolean;
    min_priority?: InboxPriority;
  }): { messages: InboxRow[]; unread_total: number; total: number } {
    this.pruneOldInbox();
    const limit = input.limit ?? 50;

    // Visibility: messages addressed to me (to_session = me) OR broadcast (to_session IS NULL).
    // Always exclude my own posts.
    const visibility =
      "i.project = ? AND i.from_session != ? AND (i.to_session IS NULL OR i.to_session = ?)";
    const visibilityArgs = [
      input.project,
      input.session_id,
      input.session_id,
    ] as const;

    const priorityFilter = priorityFilterClause(input.min_priority);

    let rows: InboxRow[];

    if (input.unread_only) {
      rows = this.db
        .prepare(
          `
          SELECT i.* FROM inbox i
          LEFT JOIN inbox_reads r
            ON r.message_id = i.id AND r.session_id = ?
          WHERE ${visibility} AND r.message_id IS NULL${priorityFilter}
          ORDER BY i.created_at DESC
          LIMIT ?
        `,
        )
        .all(input.session_id, ...visibilityArgs, limit) as InboxRow[];
    } else {
      rows = this.db
        .prepare(
          `
          SELECT i.* FROM inbox i
          WHERE ${visibility}${priorityFilter}
          ORDER BY i.created_at DESC
          LIMIT ?
        `,
        )
        .all(...visibilityArgs, limit) as InboxRow[];
    }

    const unreadCountRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS n FROM inbox i
        LEFT JOIN inbox_reads r
          ON r.message_id = i.id AND r.session_id = ?
        WHERE ${visibility} AND r.message_id IS NULL${priorityFilter}
      `,
      )
      .get(input.session_id, ...visibilityArgs) as { n: number };

    const totalCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM inbox i WHERE ${visibility}${priorityFilter}`,
      )
      .get(...visibilityArgs) as { n: number };

    if (rows.length > 0 && !input.peek) {
      const markStmt = this.db.prepare(
        "INSERT OR IGNORE INTO inbox_reads (session_id, message_id, read_at) VALUES (?, ?, ?)",
      );
      const now = this.now();
      const tx = this.db.transaction((messages: InboxRow[]) => {
        for (const m of messages) markStmt.run(input.session_id, m.id, now);
      });
      tx(rows);
    }

    return {
      messages: rows,
      unread_total: unreadCountRow.n,
      total: totalCountRow.n,
    };
  }
}

function priorityFilterClause(min?: InboxPriority): string {
  if (!min || min === "info") return "";
  if (min === "warning") return " AND i.priority IN ('warning', 'urgent')";
  return " AND i.priority = 'urgent'";
}

import type Database from "better-sqlite3";
import {
  INBOX_RETENTION_MS,
  LOCK_DEFAULT_TTL_MS,
  SESSION_TTL_MS,
} from "./schema.js";
import type {
  InboxPriority,
  InboxRow,
  LockWaiterRow,
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
  client_session_id?: string | null;
}

export class ClientSessionConflictError extends Error {
  constructor(
    public readonly client_session_id: string,
    public readonly held_by: string,
  ) {
    super(
      `client_session_id "${client_session_id}" is already mapped to session "${held_by}"`,
    );
    this.name = "ClientSessionConflictError";
  }
}

export interface ClaimResult {
  ok: boolean;
  lock?: ResourceLockRow;
  held_by?: ResourceLockRow;
  session_recreated?: boolean;
  queued?: boolean;
  queue_position?: number;
}

export interface HeartbeatResult {
  ok: boolean;
  reason?: "session_not_found";
  advice?: string;
  recreated?: boolean;
  renewed_locks?: number;
}

export interface ReleaseResult {
  released: boolean;
  reason?: string;
  notified_waiter?: string;
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

  pruneExpiredLocks(skipWaiter?: {
    project: string;
    resource: string;
    session_id: string;
  }): number {
    const now = this.now();
    const expired = this.db
      .prepare("SELECT * FROM resource_locks WHERE expires_at < ?")
      .all(now) as ResourceLockRow[];
    for (const lock of expired) {
      const skip =
        skipWaiter &&
        skipWaiter.project === lock.project &&
        skipWaiter.resource === lock.resource
          ? skipWaiter.session_id
          : undefined;
      this.notifyNextWaiter(lock.project, lock.resource, {
        from_session: lock.session_id,
        message: `Lock on '${lock.resource}' held by '${lock.session_id}' expired and the resource is now free. You were first in the waiting queue: claim it with resource_claim.`,
        skip_session: skip,
      });
    }
    const stmt = this.db.prepare(
      "DELETE FROM resource_locks WHERE expires_at < ?",
    );
    return stmt.run(now).changes;
  }

  private notifyNextWaiter(
    project: string,
    resource: string,
    opts: { from_session: string; message: string; skip_session?: string },
  ): string | undefined {
    const next = this.db
      .prepare(
        "SELECT * FROM lock_waiters WHERE project = ? AND resource = ? ORDER BY rowid ASC LIMIT 1",
      )
      .get(project, resource) as LockWaiterRow | undefined;
    if (!next) return undefined;

    this.db
      .prepare(
        "DELETE FROM lock_waiters WHERE project = ? AND resource = ? AND session_id = ?",
      )
      .run(project, resource, next.session_id);

    if (next.session_id === opts.skip_session) return undefined;

    this.broadcast({
      project,
      from_session: opts.from_session,
      to_session: next.session_id,
      priority: "warning",
      message: opts.message,
      tags: ["lock-queue", resource],
    });
    return next.session_id;
  }

  getWaiters(project: string, resource: string): LockWaiterRow[] {
    return this.db
      .prepare(
        "SELECT * FROM lock_waiters WHERE project = ? AND resource = ? ORDER BY rowid ASC",
      )
      .all(project, resource) as LockWaiterRow[];
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
    const clientId = input.client_session_id ?? null;

    if (clientId) {
      const holder = this.db
        .prepare(
          "SELECT id FROM sessions WHERE client_session_id = ? AND id != ?",
        )
        .get(clientId, input.id) as { id: string } | undefined;
      if (holder) {
        throw new ClientSessionConflictError(clientId, holder.id);
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, project, branch, intent, pid, hostname, started_at, last_heartbeat, metadata, client_session_id)
      VALUES (@id, @project, @branch, @intent, @pid, @hostname, @started_at, @last_heartbeat, @metadata, @client_session_id)
      ON CONFLICT(id) DO UPDATE SET
        project = excluded.project,
        branch = excluded.branch,
        intent = excluded.intent,
        pid = excluded.pid,
        hostname = excluded.hostname,
        last_heartbeat = excluded.last_heartbeat,
        metadata = excluded.metadata,
        client_session_id = COALESCE(excluded.client_session_id, sessions.client_session_id)
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
      client_session_id: clientId,
    });
    return this.getSession(input.id)!;
  }

  findByClientSessionId(
    clientSessionId: string,
    project?: string,
  ): SessionRow | undefined {
    this.pruneDeadSessions();
    if (project) {
      return this.db
        .prepare(
          "SELECT * FROM sessions WHERE client_session_id = ? AND project = ?",
        )
        .get(clientSessionId, project) as SessionRow | undefined;
    }
    return this.db
      .prepare("SELECT * FROM sessions WHERE client_session_id = ?")
      .get(clientSessionId) as SessionRow | undefined;
  }

  heartbeat(
    sessionId: string,
    recreateWith?: RegisterSessionInput,
    options?: { renew_locks?: boolean },
  ): HeartbeatResult {
    const now = this.now();
    const stmt = this.db.prepare(
      "UPDATE sessions SET last_heartbeat = ? WHERE id = ?",
    );
    const updated = stmt.run(now, sessionId).changes > 0;
    if (updated) {
      if (options?.renew_locks) {
        const renewed = this.db
          .prepare(
            `UPDATE resource_locks
             SET expires_at = ? + COALESCE(ttl_seconds, ?) * 1000
             WHERE session_id = ? AND expires_at >= ?`,
          )
          .run(now, LOCK_DEFAULT_TTL_MS / 1000, sessionId, now).changes;
        return { ok: true, renewed_locks: renewed };
      }
      return { ok: true };
    }

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

  unregisterByClientSessionId(clientSessionId: string): {
    removed: boolean;
    session_id?: string;
    reason?: string;
  } {
    const row = this.db
      .prepare("SELECT id FROM sessions WHERE client_session_id = ?")
      .get(clientSessionId) as { id: string } | undefined;
    if (!row) return { removed: false, reason: "session_not_found" };
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
    return { removed: true, session_id: row.id };
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
    wait?: boolean;
  }): ClaimResult {
    this.pruneExpiredLocks({
      project: input.project,
      resource: input.resource,
      session_id: input.session_id,
    });
    const now = this.now();
    const ttlSeconds = input.ttl_seconds ?? LOCK_DEFAULT_TTL_MS / 1000;
    const expires_at = now + ttlSeconds * 1000;

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
      let queued: boolean | undefined;
      let queue_position: number | undefined;
      if (input.wait) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO lock_waiters (project, resource, session_id, requested_at) VALUES (?, ?, ?, ?)",
          )
          .run(input.project, input.resource, input.session_id, now);
        const pos = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM lock_waiters
             WHERE project = ? AND resource = ?
               AND rowid <= (SELECT rowid FROM lock_waiters WHERE project = ? AND resource = ? AND session_id = ?)`,
          )
          .get(
            input.project,
            input.resource,
            input.project,
            input.resource,
            input.session_id,
          ) as { n: number };
        queued = true;
        queue_position = pos.n;
      }
      return {
        ok: false,
        held_by: existing,
        session_recreated: sessionRecreated || undefined,
        queued,
        queue_position,
      };
    }

    const stmt = this.db.prepare(`
      INSERT INTO resource_locks (resource, project, session_id, branch, reason, acquired_at, expires_at, ttl_seconds)
      VALUES (@resource, @project, @session_id, @branch, @reason, @acquired_at, @expires_at, @ttl_seconds)
      ON CONFLICT(project, resource) DO UPDATE SET
        session_id = excluded.session_id,
        branch = excluded.branch,
        reason = excluded.reason,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        ttl_seconds = excluded.ttl_seconds
    `);
    stmt.run({
      resource: input.resource,
      project: input.project,
      session_id: input.session_id,
      branch: input.branch ?? null,
      reason: input.reason ?? null,
      acquired_at: existing ? existing.acquired_at : now,
      expires_at,
      ttl_seconds: ttlSeconds,
    });

    this.db
      .prepare(
        "DELETE FROM lock_waiters WHERE project = ? AND resource = ? AND session_id = ?",
      )
      .run(input.project, input.resource, input.session_id);

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
  }): ReleaseResult {
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

    const notified = this.notifyNextWaiter(input.project, input.resource, {
      from_session: input.session_id,
      message: `Resource '${input.resource}' was just released and is now available. You were first in the waiting queue: claim it with resource_claim.`,
      skip_session: input.session_id,
    });
    return notified ? { released: true, notified_waiter: notified } : { released: true };
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
    reply_to?: number | null;
  }): InboxRow {
    this.pruneOldInbox();
    const stmt = this.db.prepare(`
      INSERT INTO inbox (project, from_session, from_branch, to_session, priority, message, tags, created_at, reply_to)
      VALUES (@project, @from_session, @from_branch, @to_session, @priority, @message, @tags, @created_at, @reply_to)
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
      reply_to: input.reply_to ?? null,
    });
    return this.db
      .prepare("SELECT * FROM inbox WHERE id = ?")
      .get(result.lastInsertRowid) as InboxRow;
  }

  getInboxMessage(id: number): InboxRow | undefined {
    return this.db
      .prepare("SELECT * FROM inbox WHERE id = ?")
      .get(id) as InboxRow | undefined;
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

import type Database from "better-sqlite3";
import {
  INBOX_RETENTION_MS,
  LOCK_DEFAULT_TTL_MS,
  SESSION_TTL_MS,
} from "./schema.js";
import type {
  ClosedProjectRow,
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
  client_session_id?: string | null;
  /** Server-stamped from the auth token — never taken from client args. */
  identity?: string | null;
}

export class ProjectClosedError extends Error {
  constructor(public readonly project: string) {
    super(
      `project "${project}" is closed. New broadcasts and registrations are refused; read_inbox still works for draining.`,
    );
    this.name = "ProjectClosedError";
  }
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
}

export interface HeartbeatResult {
  ok: boolean;
  reason?: "session_not_found";
  advice?: string;
  recreated?: boolean;
}

export class Repository {
  /**
   * Listeners invoked synchronously after each successful broadcast INSERT.
   * The WS push layer subscribes here; errors in listeners never break the write.
   */
  private broadcastListeners = new Set<(row: InboxRow) => void>();

  constructor(private readonly db: Database.Database) {}

  now(): number {
    return Date.now();
  }

  onBroadcast(listener: (row: InboxRow) => void): () => void {
    this.broadcastListeners.add(listener);
    return () => this.broadcastListeners.delete(listener);
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
    const clientId = input.client_session_id ?? null;

    if (this.isProjectClosed(input.project)) {
      throw new ProjectClosedError(input.project);
    }

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
      INSERT INTO sessions (id, project, branch, intent, pid, hostname, started_at, last_heartbeat, metadata, client_session_id, identity)
      VALUES (@id, @project, @branch, @intent, @pid, @hostname, @started_at, @last_heartbeat, @metadata, @client_session_id, @identity)
      ON CONFLICT(id) DO UPDATE SET
        project = excluded.project,
        branch = excluded.branch,
        intent = excluded.intent,
        pid = excluded.pid,
        hostname = excluded.hostname,
        last_heartbeat = excluded.last_heartbeat,
        metadata = excluded.metadata,
        client_session_id = COALESCE(excluded.client_session_id, sessions.client_session_id),
        identity = COALESCE(excluded.identity, sessions.identity)
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
      identity: input.identity ?? null,
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
    /** Server-stamped from the auth token — never taken from client args. */
    from_identity?: string | null;
    act?: string | null;
    cid?: string | null;
    fim?: boolean | null;
    rt?: string | null;
  }): InboxRow {
    this.pruneOldInbox();
    if (this.isProjectClosed(input.project)) {
      throw new ProjectClosedError(input.project);
    }
    const stmt = this.db.prepare(`
      INSERT INTO inbox (project, from_session, from_branch, to_session, priority, message, tags, created_at, from_identity, act, cid, fim, rt)
      VALUES (@project, @from_session, @from_branch, @to_session, @priority, @message, @tags, @created_at, @from_identity, @act, @cid, @fim, @rt)
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
      from_identity: input.from_identity ?? null,
      act: input.act ?? null,
      cid: input.cid ?? null,
      fim: input.fim === null || input.fim === undefined ? null : input.fim ? 1 : 0,
      rt: input.rt ?? null,
    });
    const row = this.db
      .prepare("SELECT * FROM inbox WHERE id = ?")
      .get(result.lastInsertRowid) as InboxRow;
    for (const listener of this.broadcastListeners) {
      try {
        listener(row);
      } catch {
        // push is best-effort; a bad listener never breaks the write
      }
    }
    return row;
  }

  readInbox(input: {
    project: string;
    session_id: string;
    unread_only?: boolean;
    limit?: number;
    peek?: boolean;
    min_priority?: InboxPriority;
    /** Cursor: only messages with id > since_id, ascending. Dedup becomes server-authoritative. */
    since_id?: number;
    /** Envelope filters (see broadcast act/cid/fim). */
    act?: string;
    cid?: string;
    fim?: boolean;
  }): { messages: InboxRow[]; unread_total: number; total: number; max_id: number } {
    this.pruneOldInbox();
    const limit = input.limit ?? 50;
    const cursor = input.since_id !== undefined;

    // Visibility: messages addressed to me (to_session = me) OR broadcast (to_session IS NULL).
    // Always exclude my own posts.
    const visibility =
      "i.project = ? AND i.from_session != ? AND (i.to_session IS NULL OR i.to_session = ?)";
    const visibilityArgs: unknown[] = [
      input.project,
      input.session_id,
      input.session_id,
    ];

    let extra = priorityFilterClause(input.min_priority);
    const extraArgs: unknown[] = [];
    if (cursor) {
      extra += " AND i.id > ?";
      extraArgs.push(input.since_id);
    }
    if (input.act !== undefined) {
      extra += " AND i.act = ?";
      extraArgs.push(input.act);
    }
    if (input.cid !== undefined) {
      extra += " AND i.cid = ?";
      extraArgs.push(input.cid);
    }
    if (input.fim !== undefined) {
      extra += " AND i.fim = ?";
      extraArgs.push(input.fim ? 1 : 0);
    }

    // Cursor reads walk FORWARD (ascending id) so the client never skips a
    // message; the classic read stays newest-first.
    const order = cursor ? "i.id ASC" : "i.created_at DESC";

    let rows: InboxRow[];

    if (input.unread_only) {
      rows = this.db
        .prepare(
          `
          SELECT i.* FROM inbox i
          LEFT JOIN inbox_reads r
            ON r.message_id = i.id AND r.session_id = ?
          WHERE ${visibility} AND r.message_id IS NULL${extra}
          ORDER BY ${order}
          LIMIT ?
        `,
        )
        .all(input.session_id, ...visibilityArgs, ...extraArgs, limit) as InboxRow[];
    } else {
      rows = this.db
        .prepare(
          `
          SELECT i.* FROM inbox i
          WHERE ${visibility}${extra}
          ORDER BY ${order}
          LIMIT ?
        `,
        )
        .all(...visibilityArgs, ...extraArgs, limit) as InboxRow[];
    }

    const unreadCountRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS n FROM inbox i
        LEFT JOIN inbox_reads r
          ON r.message_id = i.id AND r.session_id = ?
        WHERE ${visibility} AND r.message_id IS NULL${extra}
      `,
      )
      .get(input.session_id, ...visibilityArgs, ...extraArgs) as { n: number };

    const totalCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM inbox i WHERE ${visibility}${extra}`,
      )
      .get(...visibilityArgs, ...extraArgs) as { n: number };

    // Highest id currently visible in the project (ignores filters): lets a
    // cursor client advance past silence — 0 fresh messages still moves the cursor.
    const maxIdRow = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM inbox WHERE project = ?")
      .get(input.project) as { n: number };

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
      max_id: maxIdRow.n,
    };
  }

  // ── Room lifecycle ────────────────────────────────────────────────────────

  isProjectClosed(project: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM closed_projects WHERE project = ?")
        .get(project) !== undefined
    );
  }

  getClosedProject(project: string): ClosedProjectRow | undefined {
    return this.db
      .prepare("SELECT * FROM closed_projects WHERE project = ?")
      .get(project) as ClosedProjectRow | undefined;
  }

  /**
   * Close a room: refuse new broadcasts/registrations, drop its (ghost)
   * sessions and locks. Messages stay readable until the retention prune.
   * Idempotent; reopen undoes it.
   */
  closeProject(input: {
    project: string;
    closed_by: string;
    closed_identity?: string | null;
    reason?: string | null;
  }): { closed: boolean; already_closed: boolean; sessions_removed: number } {
    const existing = this.getClosedProject(input.project);
    if (existing) {
      return { closed: true, already_closed: true, sessions_removed: 0 };
    }
    const sessionsRemoved = this.db
      .prepare("DELETE FROM sessions WHERE project = ?")
      .run(input.project).changes;
    this.db
      .prepare("DELETE FROM resource_locks WHERE project = ?")
      .run(input.project);
    this.db
      .prepare(
        "INSERT INTO closed_projects (project, closed_by, closed_identity, reason, closed_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        input.project,
        input.closed_by,
        input.closed_identity ?? null,
        input.reason ?? null,
        this.now(),
      );
    return { closed: true, already_closed: false, sessions_removed: sessionsRemoved };
  }

  reopenProject(project: string): { reopened: boolean } {
    const changes = this.db
      .prepare("DELETE FROM closed_projects WHERE project = ?")
      .run(project).changes;
    return { reopened: changes > 0 };
  }
}

function priorityFilterClause(min?: InboxPriority): string {
  if (!min || min === "info") return "";
  if (min === "warning") return " AND i.priority IN ('warning', 'urgent')";
  return " AND i.priority = 'urgent'";
}

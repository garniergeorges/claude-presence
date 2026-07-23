import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SCHEMA_SQL } from "./schema.js";

export interface SessionRow {
  id: string;
  project: string;
  branch: string | null;
  intent: string | null;
  pid: number | null;
  hostname: string | null;
  started_at: number;
  last_heartbeat: number;
  metadata: string | null;
  client_session_id: string | null;
}

export interface ResourceLockRow {
  resource: string;
  project: string;
  session_id: string;
  branch: string | null;
  reason: string | null;
  acquired_at: number;
  expires_at: number;
  ttl_seconds: number | null;
  capacity: number;
}

export interface LockWaiterRow {
  project: string;
  resource: string;
  session_id: string;
  requested_at: number;
}

export type InboxPriority = "info" | "warning" | "urgent";

export interface InboxRow {
  id: number;
  project: string;
  from_session: string;
  from_branch: string | null;
  to_session: string | null;
  priority: InboxPriority;
  message: string;
  tags: string | null;
  created_at: number;
  reply_to: number | null;
}

export function getDefaultDbPath(): string {
  const override = process.env.CLAUDE_PRESENCE_DB;
  if (override) return override;
  return join(homedir(), ".claude-presence", "state.db");
}

export function openDatabase(dbPath: string = getDefaultDbPath()): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  migrateInbox(db);
  migrateSessions(db);
  migrateLocks(db);
  return db;
}

function migrateLocks(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(resource_locks)")
    .all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has("ttl_seconds")) {
    db.exec("ALTER TABLE resource_locks ADD COLUMN ttl_seconds INTEGER");
  }
  // Counted locks changed the primary key from (project, resource) to
  // (project, resource, session_id), which SQLite cannot ALTER in place.
  // The capacity column doubles as the migration marker. Rows whose session
  // vanished are dropped to satisfy the FK; they were unreachable anyway.
  if (!has("capacity")) {
    db.exec(`
      CREATE TABLE resource_locks_new (
        resource TEXT NOT NULL,
        project TEXT NOT NULL,
        session_id TEXT NOT NULL,
        branch TEXT,
        reason TEXT,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ttl_seconds INTEGER,
        capacity INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (project, resource, session_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      INSERT INTO resource_locks_new (resource, project, session_id, branch, reason, acquired_at, expires_at, ttl_seconds, capacity)
        SELECT l.resource, l.project, l.session_id, l.branch, l.reason, l.acquired_at, l.expires_at, l.ttl_seconds, 1
        FROM resource_locks l
        JOIN sessions s ON s.id = l.session_id;
      DROP TABLE resource_locks;
      ALTER TABLE resource_locks_new RENAME TO resource_locks;
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_locks_expires ON resource_locks(expires_at);
    CREATE INDEX IF NOT EXISTS idx_locks_session ON resource_locks(session_id);
  `);
}

function migrateSessions(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(sessions)")
    .all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has("client_session_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN client_session_id TEXT");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_client_id ON sessions(client_session_id)",
  );
}

function migrateInbox(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(inbox)")
    .all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has("to_session")) {
    db.exec("ALTER TABLE inbox ADD COLUMN to_session TEXT");
  }
  if (!has("priority")) {
    db.exec("ALTER TABLE inbox ADD COLUMN priority TEXT NOT NULL DEFAULT 'info'");
  }
  if (!has("reply_to")) {
    db.exec("ALTER TABLE inbox ADD COLUMN reply_to INTEGER");
  }
  // Always (re)attempt the index — IF NOT EXISTS handles fresh DBs and
  // re-opens after the columns were added. Kept out of SCHEMA_SQL so the
  // initial db.exec doesn't reference a column that does not exist yet
  // on databases predating PR #19.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_inbox_to_session ON inbox(to_session)",
  );
}

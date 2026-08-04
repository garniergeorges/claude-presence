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
  /** Server-stamped: the auth token's name. Clients cannot forge it. */
  identity: string | null;
}

export interface ResourceLockRow {
  resource: string;
  project: string;
  session_id: string;
  branch: string | null;
  reason: string | null;
  acquired_at: number;
  expires_at: number;
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
  /** Server-stamped: the auth token's name. Clients cannot forge it. */
  from_identity: string | null;
  /** Structured C2C envelope fields — optional, promoted out of the message body. */
  act: string | null;
  cid: string | null;
  fim: number | null;
  rt: string | null;
}

export interface ClosedProjectRow {
  project: string;
  closed_by: string;
  closed_identity: string | null;
  reason: string | null;
  closed_at: number;
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
  return db;
}

function migrateSessions(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(sessions)")
    .all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has("client_session_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN client_session_id TEXT");
  }
  if (!has("identity")) {
    db.exec("ALTER TABLE sessions ADD COLUMN identity TEXT");
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
  // Always (re)attempt the index — IF NOT EXISTS handles fresh DBs and
  // re-opens after the columns were added. Kept out of SCHEMA_SQL so the
  // initial db.exec doesn't reference a column that does not exist yet
  // on databases predating PR #19.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_inbox_to_session ON inbox(to_session)",
  );
  // v0.5.0 additive columns: server-stamped identity + structured C2C envelope.
  if (!has("from_identity")) {
    db.exec("ALTER TABLE inbox ADD COLUMN from_identity TEXT");
  }
  for (const col of ["act", "cid", "rt"]) {
    if (!has(col)) db.exec(`ALTER TABLE inbox ADD COLUMN ${col} TEXT`);
  }
  if (!has("fim")) {
    db.exec("ALTER TABLE inbox ADD COLUMN fim INTEGER");
  }
  // Cursor reads (since_id) walk ascending ids within a project.
  db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_project_id ON inbox(project, id)");
}

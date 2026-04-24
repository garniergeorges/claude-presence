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

export interface InboxRow {
  id: number;
  project: string;
  from_session: string;
  from_branch: string | null;
  message: string;
  tags: string | null;
  created_at: number;
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
  return db;
}

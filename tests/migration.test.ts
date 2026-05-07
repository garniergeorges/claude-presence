import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { Repository } from "../src/db/repository.js";

// Schema as it shipped in v0.2.1 (before PR #19 added to_session + priority).
// Reproducing it verbatim ensures we exercise the same migration path real
// users face when upgrading their on-disk SQLite file.
const V021_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  branch TEXT,
  intent TEXT,
  pid INTEGER,
  hostname TEXT,
  started_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  metadata TEXT
);
CREATE INDEX idx_sessions_project ON sessions(project);
CREATE INDEX idx_sessions_heartbeat ON sessions(last_heartbeat);

CREATE TABLE resource_locks (
  resource TEXT NOT NULL,
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch TEXT,
  reason TEXT,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project, resource),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_locks_expires ON resource_locks(expires_at);
CREATE INDEX idx_locks_session ON resource_locks(session_id);

CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  from_session TEXT NOT NULL,
  from_branch TEXT,
  message TEXT NOT NULL,
  tags TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_inbox_project ON inbox(project, created_at DESC);

CREATE TABLE inbox_reads (
  session_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id)
);
`;

describe("openDatabase migration — upgrades v0.2.1 schema in place", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-presence-mig-"));
    dbPath = join(tmpDir, "state.db");

    // Seed an "old" database exactly as v0.2.1 would have left it,
    // with one inbox row pre-existing to make sure we don't lose data.
    const seed = new Database(dbPath);
    seed.exec(V021_SCHEMA);
    seed.prepare(
      "INSERT INTO sessions (id, project, started_at, last_heartbeat) VALUES (?, ?, ?, ?)",
    ).run("alice", "/repo", Date.now(), Date.now());
    seed.prepare(
      "INSERT INTO inbox (project, from_session, message, created_at) VALUES (?, ?, ?, ?)",
    ).run("/repo", "alice", "legacy message", Date.now());
    seed.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens a v0.2.1 database without throwing", () => {
    const db = openDatabase(dbPath);
    db.close();
  });

  it("adds to_session and priority columns to the existing inbox table", () => {
    const db = openDatabase(dbPath);
    const cols = db
      .prepare("PRAGMA table_info(inbox)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("to_session");
    expect(names).toContain("priority");
    db.close();
  });

  it("creates idx_inbox_to_session after the column is added", () => {
    const db = openDatabase(dbPath);
    const indexes = db
      .prepare("PRAGMA index_list(inbox)")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_inbox_to_session");
    db.close();
  });

  it("preserves pre-existing rows and defaults priority to 'info'", () => {
    const db = openDatabase(dbPath);
    const repo = new Repository(db);
    const inbox = repo.readInbox({
      project: "/repo",
      session_id: "bob",
      unread_only: false,
    });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].message).toBe("legacy message");
    expect(inbox.messages[0].priority).toBe("info");
    expect(inbox.messages[0].to_session).toBeNull();
    db.close();
  });

  it("is idempotent — opening the migrated db a second time is a no-op", () => {
    const db1 = openDatabase(dbPath);
    db1.close();
    const db2 = openDatabase(dbPath);
    const cols = db2
      .prepare("PRAGMA table_info(inbox)")
      .all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === "to_session")).toHaveLength(1);
    expect(cols.filter((c) => c.name === "priority")).toHaveLength(1);
    db2.close();
  });
});

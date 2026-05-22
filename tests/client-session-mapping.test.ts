import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import {
  ClientSessionConflictError,
  Repository,
} from "../src/db/repository.js";
import { freshRepo } from "./helpers.js";

const CLI_PATH = resolve(__dirname, "..", "dist", "cli", "index.js");

function runCli(env: Record<string, string>, args: string[]): unknown {
  const out = execFileSync("node", [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  }).trim();
  return JSON.parse(out);
}

describe("client_session_id mapping — Repository", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
  });

  afterEach(() => db.close());

  it("stores client_session_id when provided at register", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo",
      client_session_id: "uuid-aaa",
    });
    const row = repo.getSession("alice");
    expect(row?.client_session_id).toBe("uuid-aaa");
  });

  it("findByClientSessionId returns the mapped session", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo",
      client_session_id: "uuid-aaa",
    });
    const found = repo.findByClientSessionId("uuid-aaa");
    expect(found?.id).toBe("alice");
  });

  it("findByClientSessionId returns undefined when no mapping exists", () => {
    repo.registerSession({ id: "alice", project: "/repo" });
    expect(repo.findByClientSessionId("uuid-ghost")).toBeUndefined();
  });

  it("scopes findByClientSessionId by project when provided", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo-A",
      client_session_id: "uuid-aaa",
    });
    expect(repo.findByClientSessionId("uuid-aaa", "/repo-A")?.id).toBe("alice");
    expect(repo.findByClientSessionId("uuid-aaa", "/repo-B")).toBeUndefined();
  });

  it("throws ClientSessionConflictError when a different session reclaims the same client_session_id", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo",
      client_session_id: "uuid-aaa",
    });
    expect(() =>
      repo.registerSession({
        id: "bob",
        project: "/repo",
        client_session_id: "uuid-aaa",
      }),
    ).toThrow(ClientSessionConflictError);
  });

  it("does not throw when the same session re-registers with the same client_session_id", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo",
      client_session_id: "uuid-aaa",
    });
    expect(() =>
      repo.registerSession({
        id: "alice",
        project: "/repo",
        branch: "feat/x",
        client_session_id: "uuid-aaa",
      }),
    ).not.toThrow();
    expect(repo.getSession("alice")?.branch).toBe("feat/x");
  });

  it("preserves a previously-set client_session_id when register is called again without it (COALESCE)", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo",
      client_session_id: "uuid-aaa",
    });

    // Legacy register (e.g. heartbeat-recreate fallback) does not pass it.
    repo.registerSession({
      id: "alice",
      project: "/repo",
      branch: "feat/y",
    });

    expect(repo.getSession("alice")?.client_session_id).toBe("uuid-aaa");
    expect(repo.getSession("alice")?.branch).toBe("feat/y");
  });
});

describe("client_session_id mapping — CLI resolve-session", () => {
  let tmpDir: string;
  let dbPath: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-presence-resolve-"));
    dbPath = join(tmpDir, "state.db");
    env = { CLAUDE_PRESENCE_DB: dbPath };
    const db = openDatabase(dbPath);
    const repo = new Repository(db);
    repo.registerSession({
      id: "alice",
      project: "/myproj",
      branch: "main",
      client_session_id: "claude-uuid-alice",
    });
    repo.registerSession({
      id: "alice-other-project",
      project: "/other",
      client_session_id: "claude-uuid-other",
    });
    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits {session_id} when the client id is mapped", () => {
    const out = runCli(env, [
      "resolve-session",
      "--client",
      "claude-uuid-alice",
      "--json",
    ]) as { session_id: string; project: string; branch: string };
    expect(out.session_id).toBe("alice");
    expect(out.project).toBe("/myproj");
    expect(out.branch).toBe("main");
  });

  it("emits {session_id: null} when nothing is mapped", () => {
    const out = runCli(env, [
      "resolve-session",
      "--client",
      "unknown-uuid",
      "--json",
    ]);
    expect(out).toEqual({ session_id: null });
  });

  it("scopes by --project when provided", () => {
    const matching = runCli(env, [
      "resolve-session",
      "--client",
      "claude-uuid-alice",
      "--project",
      "/myproj",
      "--json",
    ]) as { session_id: string };
    expect(matching.session_id).toBe("alice");

    const mismatch = runCli(env, [
      "resolve-session",
      "--client",
      "claude-uuid-alice",
      "--project",
      "/wrong-project",
      "--json",
    ]);
    expect(mismatch).toEqual({ session_id: null });
  });
});

describe("client_session_id mapping — migration from older schema", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-presence-mig-cs-"));
    dbPath = join(tmpDir, "state.db");

    // Seed a sessions table WITHOUT client_session_id (pre-feature schema).
    const seed = new Database(dbPath);
    seed.exec(`
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
    `);
    seed.prepare(
      "INSERT INTO sessions (id, project, started_at, last_heartbeat) VALUES (?, ?, ?, ?)",
    ).run("legacy", "/legacy-proj", Date.now(), Date.now());
    seed.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds the client_session_id column without throwing", () => {
    const db = openDatabase(dbPath);
    const cols = db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("client_session_id");
    db.close();
  });

  it("creates idx_sessions_client_id after the column is added", () => {
    const db = openDatabase(dbPath);
    const indexes = db
      .prepare("PRAGMA index_list(sessions)")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_sessions_client_id");
    db.close();
  });

  it("preserves the pre-existing row with client_session_id = null", () => {
    const db = openDatabase(dbPath);
    const repo = new Repository(db);
    const row = repo.getSession("legacy");
    expect(row?.id).toBe("legacy");
    expect(row?.client_session_id).toBeNull();
    db.close();
  });

  it("is idempotent — opening twice does not duplicate columns", () => {
    openDatabase(dbPath).close();
    const db = openDatabase(dbPath);
    const cols = db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === "client_session_id")).toHaveLength(1);
    db.close();
  });
});

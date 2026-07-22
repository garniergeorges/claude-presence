import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/db/index.js";
import { Repository } from "../src/db/repository.js";
import { freshRepo } from "./helpers.js";

const CLI_PATH = resolve(__dirname, "..", "dist", "cli", "index.js");

function runCli(env: Record<string, string>, args: string[]): unknown {
  const out = execFileSync("node", [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  }).trim();
  return JSON.parse(out);
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((res) => child.on("exit", res));
  return pid;
}

describe("Repository — unregister by client_session_id", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
  });

  afterEach(() => db.close());

  it("removes the session mapped to the client id", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo",
      client_session_id: "uuid-1",
    });
    const r = repo.unregisterByClientSessionId("uuid-1");
    expect(r).toEqual({ removed: true, session_id: "alice" });
    expect(repo.getSession("alice")).toBeUndefined();
  });

  it("cascades locks held by the removed session", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo",
      client_session_id: "uuid-1",
    });
    repo.claimResource({ resource: "ci", project: "/repo", session_id: "alice" });
    repo.unregisterByClientSessionId("uuid-1");
    expect(repo.listLocks("/repo")).toHaveLength(0);
  });

  it("returns session_not_found for an unknown client id", () => {
    const r = repo.unregisterByClientSessionId("uuid-ghost");
    expect(r).toEqual({ removed: false, reason: "session_not_found" });
  });
});

describe("clear — CLI targeted removal and dead-PID pruning", () => {
  let tmpDir: string;
  let dbPath: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-presence-clear-"));
    dbPath = join(tmpDir, "state.db");
    env = { CLAUDE_PRESENCE_DB: dbPath };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(fn: (repo: Repository) => void): void {
    const db = openDatabase(dbPath);
    fn(new Repository(db));
    db.close();
  }

  it("clear --session removes exactly that session", () => {
    seed((repo) => {
      repo.registerSession({ id: "alice", project: "/repo" });
      repo.registerSession({ id: "bob", project: "/repo" });
    });
    const result = runCli(env, ["clear", "--session", "alice", "--json"]);
    expect(result).toEqual({ removed: true });

    const db = openDatabase(dbPath);
    const repo = new Repository(db);
    expect(repo.getSession("alice")).toBeUndefined();
    expect(repo.getSession("bob")).toBeDefined();
    db.close();
  });

  it("clear --client removes the mapped session and reports its id", () => {
    seed((repo) => {
      repo.registerSession({
        id: "alice",
        project: "/repo",
        client_session_id: "uuid-1",
      });
    });
    const result = runCli(env, ["clear", "--client", "uuid-1", "--json"]);
    expect(result).toEqual({ removed: true, session_id: "alice" });
  });

  it("clear --session on an unknown id exits with code 2", () => {
    seed(() => {});
    let status: number | undefined;
    try {
      execFileSync("node", [CLI_PATH, "clear", "--session", "ghost"], {
        env: { ...process.env, ...env },
        encoding: "utf8",
      });
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status).toBe(2);
  });

  it("clear prunes sessions whose local process is dead, keeps live and remote ones", async () => {
    const dead = await deadPid();
    seed((repo) => {
      repo.registerSession({
        id: "dead-local",
        project: "/repo",
        pid: dead,
        hostname: hostname(),
      });
      repo.registerSession({
        id: "alive-local",
        project: "/repo",
        pid: process.pid,
        hostname: hostname(),
      });
      repo.registerSession({
        id: "dead-remote",
        project: "/repo",
        pid: dead,
        hostname: "some-other-host",
      });
      repo.registerSession({ id: "no-pid", project: "/repo" });
    });

    const result = runCli(env, ["clear", "--json"]) as {
      pruned_dead_pid_sessions: string[];
    };
    expect(result.pruned_dead_pid_sessions).toEqual(["dead-local"]);

    const db = openDatabase(dbPath);
    const repo = new Repository(db);
    expect(repo.getSession("dead-local")).toBeUndefined();
    expect(repo.getSession("alive-local")).toBeDefined();
    expect(repo.getSession("dead-remote")).toBeDefined();
    expect(repo.getSession("no-pid")).toBeDefined();
    db.close();
  });
});

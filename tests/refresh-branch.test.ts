import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("refresh-branch — idempotent branch update", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
  });

  afterEach(() => db.close());

  it("updates the stored branch when it drifts", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo",
      branch: "main",
      intent: "fixing auth",
    });

    repo.registerSession({
      id: "alice",
      project: "/repo",
      branch: "feat/login",
      intent: "fixing auth",
    });

    const after = repo.getSession("alice");
    expect(after?.branch).toBe("feat/login");
    expect(after?.intent).toBe("fixing auth");
  });

  it("preserves intent and other metadata across a branch refresh", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo",
      branch: "main",
      intent: "fixing auth",
      pid: 4242,
      hostname: "laptop",
    });

    const before = repo.getSession("alice")!;

    repo.registerSession({
      id: "alice",
      project: before.project,
      branch: "feat/x",
      intent: before.intent,
      pid: before.pid,
      hostname: before.hostname,
    });

    const after = repo.getSession("alice")!;
    expect(after.branch).toBe("feat/x");
    expect(after.intent).toBe("fixing auth");
    expect(after.pid).toBe(4242);
    expect(after.hostname).toBe("laptop");
    expect(after.started_at).toBe(before.started_at);
  });

  it("is a no-op (no row change) when the new branch matches the stored one", () => {
    repo.registerSession({
      id: "alice",
      project: "/repo",
      branch: "main",
    });
    const before = repo.getSession("alice")!;

    repo.registerSession({
      id: "alice",
      project: "/repo",
      branch: "main",
    });
    const after = repo.getSession("alice")!;

    expect(after.branch).toBe("main");
    expect(after.started_at).toBe(before.started_at);
  });

  it("does nothing for an unknown session", () => {
    expect(repo.getSession("ghost")).toBeUndefined();
  });

  it("can transition from a null branch (registered without one) to a real branch", () => {
    repo.registerSession({ id: "alice", project: "/repo" });
    expect(repo.getSession("alice")?.branch).toBeNull();

    repo.registerSession({
      id: "alice",
      project: "/repo",
      branch: "feat/y",
    });
    expect(repo.getSession("alice")?.branch).toBe("feat/y");
  });
});

describe("refresh-branch — CLI JSON contract (consumed by the hook)", () => {
  let tmpDir: string;
  let dbPath: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-presence-cli-"));
    dbPath = join(tmpDir, "state.db");
    env = { CLAUDE_PRESENCE_DB: dbPath };
    const db = openDatabase(dbPath);
    const repo = new Repository(db);
    repo.registerSession({
      id: "alice",
      project: "/myproj",
      branch: "main",
      intent: "foo",
    });
    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits {changed:false} when the branch is unchanged", () => {
    const out = runCli(env, [
      "refresh-branch",
      "--project",
      "/myproj",
      "--session",
      "alice",
      "--branch",
      "main",
      "--json",
    ]);
    expect(out).toEqual({ changed: false, branch: "main" });
  });

  it("emits {changed:true, from, to} when the branch drifted", () => {
    const out = runCli(env, [
      "refresh-branch",
      "--project",
      "/myproj",
      "--session",
      "alice",
      "--branch",
      "feat/foo",
      "--json",
    ]);
    expect(out).toEqual({ changed: true, from: "main", to: "feat/foo" });
  });

  it("emits session_not_found for an unknown session id", () => {
    const out = runCli(env, [
      "refresh-branch",
      "--project",
      "/myproj",
      "--session",
      "ghost",
      "--branch",
      "main",
      "--json",
    ]);
    expect(out).toEqual({ changed: false, reason: "session_not_found" });
  });

  it("emits project_mismatch when the cwd does not match the stored project", () => {
    const out = runCli(env, [
      "refresh-branch",
      "--project",
      "/elsewhere",
      "--session",
      "alice",
      "--branch",
      "main",
      "--json",
    ]);
    expect(out).toEqual({
      changed: false,
      reason: "project_mismatch",
      stored_project: "/myproj",
    });
  });
});

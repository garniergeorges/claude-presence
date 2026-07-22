import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/db/index.js";
import { Repository } from "../src/db/repository.js";
import { presenceTools } from "../src/tools/presence.js";
import { freshRepo } from "./helpers.js";

const CLI_PATH = resolve(__dirname, "..", "dist", "cli", "index.js");

describe("session_register — same-branch warning", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
  });

  afterEach(() => db.close());

  async function register(args: Record<string, unknown>): Promise<any> {
    const tool = presenceTools(repo).find((t) => t.name === "session_register")!;
    return tool.handler(args as never);
  }

  it("warns when another session works on the same branch", async () => {
    repo.registerSession({ id: "alice", project: "/repo", branch: "feat/x" });
    const result = await register({
      session_id: "bob",
      project: "/repo",
      branch: "feat/x",
    });
    expect(result.same_branch_sessions).toEqual(["alice"]);
    expect(result.advice).toContain("feat/x");
    expect(result.advice).toContain("alice");
  });

  it("does not warn when branches differ", async () => {
    repo.registerSession({ id: "alice", project: "/repo", branch: "feat/x" });
    const result = await register({
      session_id: "bob",
      project: "/repo",
      branch: "fix/y",
    });
    expect(result.same_branch_sessions).toBeUndefined();
    expect(result.advice).toContain("other session(s) active");
  });

  it("does not treat two branchless sessions as overlapping", async () => {
    repo.registerSession({ id: "alice", project: "/repo" });
    const result = await register({ session_id: "bob", project: "/repo" });
    expect(result.same_branch_sessions).toBeUndefined();
  });

  it("scopes the warning to the project", async () => {
    repo.registerSession({ id: "alice", project: "/other", branch: "feat/x" });
    const result = await register({
      session_id: "bob",
      project: "/repo",
      branch: "feat/x",
    });
    expect(result.same_branch_sessions).toBeUndefined();
  });
});

describe("refresh-branch — same_branch field in the CLI contract", () => {
  let tmpDir: string;
  let dbPath: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-presence-samebranch-"));
    dbPath = join(tmpDir, "state.db");
    env = { CLAUDE_PRESENCE_DB: dbPath };
    const db = openDatabase(dbPath);
    const repo = new Repository(db);
    repo.registerSession({ id: "alice", project: "/myproj", branch: "main" });
    repo.registerSession({ id: "bob", project: "/myproj", branch: "feat/z" });
    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runRefresh(branch: string): any {
    const out = execFileSync(
      "node",
      [
        CLI_PATH,
        "refresh-branch",
        "--project",
        "/myproj",
        "--session",
        "alice",
        "--branch",
        branch,
        "--json",
      ],
      { env: { ...process.env, ...env }, encoding: "utf8" },
    ).trim();
    return JSON.parse(out);
  }

  it("reports same_branch when landing on an occupied branch", () => {
    const result = runRefresh("feat/z");
    expect(result).toEqual({
      changed: true,
      from: "main",
      to: "feat/z",
      same_branch: ["bob"],
    });
  });

  it("omits same_branch when the new branch is free", () => {
    const result = runRefresh("feat/solo");
    expect(result).toEqual({ changed: true, from: "main", to: "feat/solo" });
  });
});

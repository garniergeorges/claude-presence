import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { Repository } from "../src/db/repository.js";

const CLI_PATH = resolve(__dirname, "..", "dist", "cli", "index.js");

describe("dashboard — CLI combined view", () => {
  let tmpDir: string;
  let dbPath: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-presence-dash-"));
    dbPath = join(tmpDir, "state.db");
    env = { CLAUDE_PRESENCE_DB: dbPath };

    const db = openDatabase(dbPath);
    const repo = new Repository(db);
    repo.registerSession({
      id: "alice",
      project: "/repo",
      branch: "feat/x",
      intent: "fixing auth",
    });
    repo.registerSession({ id: "bob", project: "/repo", branch: "fix/y" });
    repo.registerSession({ id: "carol", project: "/other" });
    repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "alice",
      reason: "pushing",
    });
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      to_session: "bob",
      message: "heads up",
    });
    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runDashboard(extra: string[] = []): any {
    const out = execFileSync(
      "node",
      [CLI_PATH, "dashboard", "--json", ...extra],
      { env: { ...process.env, ...env }, encoding: "utf8" },
    ).trim();
    return JSON.parse(out);
  }

  it("groups sessions and locks by project", () => {
    const result = runDashboard();
    expect(result.projects.map((p: any) => p.project)).toEqual([
      "/other",
      "/repo",
    ]);
    const repoProj = result.projects.find((p: any) => p.project === "/repo");
    expect(repoProj.sessions.map((s: any) => s.id)).toEqual(["alice", "bob"]);
    expect(repoProj.locks).toHaveLength(1);
    expect(repoProj.locks[0].resource).toBe("ci");
  });

  it("reports unread counts per session without marking messages read", () => {
    const first = runDashboard();
    const repoProj = first.projects.find((p: any) => p.project === "/repo");
    const bob = repoProj.sessions.find((s: any) => s.id === "bob");
    const alice = repoProj.sessions.find((s: any) => s.id === "alice");
    expect(bob.unread).toBe(1);
    expect(alice.unread).toBe(0);

    const second = runDashboard();
    const bobAgain = second.projects
      .find((p: any) => p.project === "/repo")
      .sessions.find((s: any) => s.id === "bob");
    expect(bobAgain.unread).toBe(1);
  });

  it("filters to one project with --project", () => {
    const result = runDashboard(["--project", "/repo"]);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].project).toBe("/repo");
  });

  it("rejects --watch combined with --json", () => {
    let status: number | undefined;
    try {
      execFileSync("node", [CLI_PATH, "dashboard", "--json", "--watch"], {
        env: { ...process.env, ...env },
        encoding: "utf8",
      });
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status).toBe(1);
  });
});

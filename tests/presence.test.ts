import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { Repository } from "../src/db/repository.js";
import { SESSION_TTL_MS } from "../src/db/schema.js";
import { freshRepo } from "./helpers.js";

describe("Repository — presence", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("registers a session and returns it on listSessions", () => {
    const row = repo.registerSession({
      id: "sess-A",
      project: "/repo",
      branch: "main",
      intent: "testing",
    });
    expect(row.id).toBe("sess-A");
    expect(row.branch).toBe("main");
    expect(row.intent).toBe("testing");
    expect(row.started_at).toBeTypeOf("number");

    const all = repo.listSessions("/repo");
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("sess-A");
  });

  it("upserts on duplicate session_id (keeps same row, refreshes fields)", () => {
    repo.registerSession({ id: "sess-A", project: "/repo", branch: "main" });
    repo.registerSession({ id: "sess-A", project: "/repo", branch: "feat/x", intent: "updated" });
    const all = repo.listSessions("/repo");
    expect(all).toHaveLength(1);
    expect(all[0].branch).toBe("feat/x");
    expect(all[0].intent).toBe("updated");
  });

  it("scopes listSessions by project", () => {
    repo.registerSession({ id: "a", project: "/repo1" });
    repo.registerSession({ id: "b", project: "/repo2" });
    expect(repo.listSessions("/repo1")).toHaveLength(1);
    expect(repo.listSessions("/repo2")).toHaveLength(1);
    expect(repo.listSessions()).toHaveLength(2);
  });

  it("heartbeat updates last_heartbeat", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    repo.registerSession({ id: "sess-A", project: "/repo" });
    const before = repo.getSession("sess-A")!.last_heartbeat;

    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
    const ok = repo.heartbeat("sess-A");
    expect(ok).toBe(true);

    const after = repo.getSession("sess-A")!.last_heartbeat;
    expect(after).toBeGreaterThan(before);
  });

  it("heartbeat returns false for unknown session", () => {
    expect(repo.heartbeat("nope")).toBe(false);
  });

  it("unregisterSession removes the row", () => {
    repo.registerSession({ id: "sess-A", project: "/repo" });
    expect(repo.unregisterSession("sess-A")).toBe(true);
    expect(repo.listSessions("/repo")).toHaveLength(0);
    expect(repo.unregisterSession("sess-A")).toBe(false);
  });

  it("prunes dead sessions past the TTL when listing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    repo.registerSession({ id: "sess-A", project: "/repo" });

    // Advance past TTL + a margin
    vi.setSystemTime(new Date(Date.now() + SESSION_TTL_MS + 1000));
    const alive = repo.listSessions("/repo");
    expect(alive).toHaveLength(0);
  });

  it("does NOT prune sessions within TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    repo.registerSession({ id: "sess-A", project: "/repo" });

    vi.setSystemTime(new Date(Date.now() + SESSION_TTL_MS - 1000));
    const alive = repo.listSessions("/repo");
    expect(alive).toHaveLength(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { Repository } from "../src/db/repository.js";
import { freshRepo } from "./helpers.js";

describe("Repository — resource locks", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "sess-A", project: "/repo", branch: "feat/x" });
    repo.registerSession({ id: "sess-B", project: "/repo", branch: "fix/y" });
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("grants the first claim", () => {
    const r = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
      reason: "pushing",
    });
    expect(r.ok).toBe(true);
    expect(r.lock?.resource).toBe("ci");
    expect(r.lock?.session_id).toBe("sess-A");
    expect(r.lock?.reason).toBe("pushing");
  });

  it("refuses a concurrent claim and returns the holder", () => {
    repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
    });
    const r = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-B",
    });
    expect(r.ok).toBe(false);
    expect(r.held_by?.session_id).toBe("sess-A");
  });

  it("allows re-claim by the same session (renewal)", () => {
    const first = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
      ttl_seconds: 60,
    });
    const second = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
      ttl_seconds: 600,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.lock?.expires_at).toBeGreaterThan(first.lock!.expires_at);
  });

  it("scopes locks per project (same resource name in two projects)", () => {
    repo.registerSession({ id: "sess-C", project: "/repo2" });
    const a = repo.claimResource({ resource: "ci", project: "/repo", session_id: "sess-A" });
    const c = repo.claimResource({ resource: "ci", project: "/repo2", session_id: "sess-C" });
    expect(a.ok).toBe(true);
    expect(c.ok).toBe(true);
  });

  it("releaseResource only works for the holder (unless force)", () => {
    repo.claimResource({ resource: "ci", project: "/repo", session_id: "sess-A" });
    const notOwner = repo.releaseResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-B",
    });
    expect(notOwner).toEqual({ released: false, reason: "not_owner" });

    const forced = repo.releaseResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-B",
      force: true,
    });
    expect(forced).toEqual({ released: true });
  });

  it("releaseResource on nothing returns not_held", () => {
    const r = repo.releaseResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
    });
    expect(r).toEqual({ released: false, reason: "not_held" });
  });

  it("prunes expired locks and lets a new claim succeed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
      ttl_seconds: 5,
    });
    expect(repo.listLocks("/repo")).toHaveLength(1);

    vi.setSystemTime(new Date(Date.now() + 10_000));
    const r = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-B",
    });
    expect(r.ok).toBe(true);
    expect(r.lock?.session_id).toBe("sess-B");
  });

  it("locks are cascade-deleted with their session", () => {
    repo.claimResource({ resource: "ci", project: "/repo", session_id: "sess-A" });
    expect(repo.listLocks("/repo")).toHaveLength(1);
    repo.unregisterSession("sess-A");
    expect(repo.listLocks("/repo")).toHaveLength(0);
  });

  it("claimResource auto-recreates a pruned session instead of failing with FK error", () => {
    // Session does NOT exist beforehand (simulating pruning)
    const r = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "ghost-session",
      branch: "feat/recreate",
    });
    expect(r.ok).toBe(true);
    expect(r.session_recreated).toBe(true);
    expect(repo.getSession("ghost-session")).toBeDefined();
    expect(repo.getSession("ghost-session")!.branch).toBe("feat/recreate");
  });

  it("claimResource does NOT set session_recreated when session already exists", () => {
    const r = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
    });
    expect(r.ok).toBe(true);
    expect(r.session_recreated).toBeUndefined();
  });
});

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

describe("Repository — lock waiting queue", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "sess-A", project: "/repo" });
    repo.registerSession({ id: "sess-B", project: "/repo" });
    repo.registerSession({ id: "sess-C", project: "/repo" });
    repo.claimResource({ resource: "ci", project: "/repo", session_id: "sess-A" });
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  const claimWait = (session_id: string) =>
    repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id,
      wait: true,
    });

  const unreadFor = (session_id: string) =>
    repo.readInbox({ project: "/repo", session_id, unread_only: true }).messages;

  it("wait=true enqueues and returns the queue position", () => {
    const b = claimWait("sess-B");
    const c = claimWait("sess-C");
    expect(b).toMatchObject({ ok: false, queued: true, queue_position: 1 });
    expect(c).toMatchObject({ ok: false, queued: true, queue_position: 2 });
    expect(repo.getWaiters("/repo", "ci").map((w) => w.session_id)).toEqual([
      "sess-B",
      "sess-C",
    ]);
  });

  it("a failed claim without wait does not enqueue", () => {
    const b = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-B",
    });
    expect(b.ok).toBe(false);
    expect(b.queued).toBeUndefined();
    expect(repo.getWaiters("/repo", "ci")).toHaveLength(0);
  });

  it("re-requesting wait keeps the original position", () => {
    claimWait("sess-B");
    claimWait("sess-C");
    const again = claimWait("sess-B");
    expect(again.queue_position).toBe(1);
    expect(repo.getWaiters("/repo", "ci")).toHaveLength(2);
  });

  it("release notifies the first waiter via inbox DM and dequeues it", () => {
    claimWait("sess-B");
    claimWait("sess-C");
    const released = repo.releaseResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
    });
    expect(released).toEqual({ released: true, notified_waiter: "sess-B" });

    const messages = unreadFor("sess-B");
    expect(messages).toHaveLength(1);
    expect(messages[0].to_session).toBe("sess-B");
    expect(messages[0].priority).toBe("warning");
    expect(messages[0].from_session).toBe("sess-A");
    expect(messages[0].message).toContain("released");

    expect(unreadFor("sess-C")).toHaveLength(0);
    expect(repo.getWaiters("/repo", "ci").map((w) => w.session_id)).toEqual([
      "sess-C",
    ]);
  });

  it("release without waiters returns no notified_waiter", () => {
    const released = repo.releaseResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
    });
    expect(released).toEqual({ released: true });
  });

  it("a successful claim removes the session from the queue", () => {
    claimWait("sess-B");
    repo.releaseResource({ resource: "ci", project: "/repo", session_id: "sess-A" });
    const r = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-B",
    });
    expect(r.ok).toBe(true);
    expect(repo.getWaiters("/repo", "ci")).toHaveLength(0);
  });

  it("an expired lock notifies the first waiter on the next prune", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
      ttl_seconds: 5,
    });
    claimWait("sess-B");

    vi.setSystemTime(new Date(Date.now() + 10_000));
    repo.listLocks("/repo");

    const messages = unreadFor("sess-B");
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain("expired");
    expect(repo.getWaiters("/repo", "ci")).toHaveLength(0);
  });

  it("first waiter claiming an expired lock is dequeued silently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
      ttl_seconds: 5,
    });
    claimWait("sess-B");

    vi.setSystemTime(new Date(Date.now() + 10_000));
    const r = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-B",
    });
    expect(r.ok).toBe(true);
    expect(unreadFor("sess-B")).toHaveLength(0);
    expect(repo.getWaiters("/repo", "ci")).toHaveLength(0);
  });

  it("waiters are cascade-deleted with their session", () => {
    claimWait("sess-B");
    repo.unregisterSession("sess-B");
    const released = repo.releaseResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
    });
    expect(released).toEqual({ released: true });
    expect(repo.getWaiters("/repo", "ci")).toHaveLength(0);
  });
});

describe("Repository — counted locks (semaphores)", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    for (const id of ["sess-A", "sess-B", "sess-C", "sess-D"]) {
      repo.registerSession({ id, project: "/repo" });
    }
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  const claim = (session_id: string, extra?: Record<string, unknown>) =>
    repo.claimResource({
      resource: "cpu-heavy",
      project: "/repo",
      session_id,
      ...extra,
    });

  const unreadFor = (session_id: string) =>
    repo.readInbox({ project: "/repo", session_id, unread_only: true }).messages;

  it("capacity=2 grants two concurrent holders and refuses the third", () => {
    expect(claim("sess-A", { capacity: 2 }).ok).toBe(true);
    expect(claim("sess-B").ok).toBe(true);
    const c = claim("sess-C");
    expect(c.ok).toBe(false);
    expect(c.capacity).toBe(2);
    expect(c.holders?.map((h) => h.session_id)).toEqual(["sess-A", "sess-B"]);
  });

  it("joiners inherit the effective capacity set by the first holder", () => {
    claim("sess-A", { capacity: 2 });
    const b = claim("sess-B", { capacity: 5 });
    expect(b.ok).toBe(true);
    expect(b.capacity).toBe(2);
    expect(claim("sess-C", { capacity: 5 }).ok).toBe(false);
  });

  it("capacity can change once every slot is released", () => {
    claim("sess-A", { capacity: 2 });
    claim("sess-B");
    repo.releaseResource({ resource: "cpu-heavy", project: "/repo", session_id: "sess-A" });
    repo.releaseResource({ resource: "cpu-heavy", project: "/repo", session_id: "sess-B" });
    const d = claim("sess-D", { capacity: 3 });
    expect(d.ok).toBe(true);
    expect(d.capacity).toBe(3);
  });

  it("re-claim by a holder renews its slot without consuming another", () => {
    claim("sess-A", { capacity: 2 });
    claim("sess-B");
    const renewed = claim("sess-A", { ttl_seconds: 900 });
    expect(renewed.ok).toBe(true);
    expect(repo.listLocks("/repo")).toHaveLength(2);
  });

  it("releasing one slot notifies the first waiter while the other holder remains", () => {
    claim("sess-A", { capacity: 2 });
    claim("sess-B");
    claim("sess-C", { wait: true });
    const released = repo.releaseResource({
      resource: "cpu-heavy",
      project: "/repo",
      session_id: "sess-B",
    });
    expect(released).toEqual({ released: true, notified_waiter: "sess-C" });
    expect(repo.listLocks("/repo").map((l) => l.session_id)).toEqual(["sess-A"]);
    expect(unreadFor("sess-C")).toHaveLength(1);
  });

  it("force release clears every slot and notifies one waiter per freed slot", () => {
    claim("sess-A", { capacity: 2 });
    claim("sess-B");
    claim("sess-C", { wait: true });
    claim("sess-D", { wait: true });
    const released = repo.releaseResource({
      resource: "cpu-heavy",
      project: "/repo",
      session_id: "outsider",
      force: true,
    });
    expect(released).toEqual({
      released: true,
      notified_waiter: "sess-C",
      notified_waiters: ["sess-C", "sess-D"],
    });
    expect(repo.listLocks("/repo")).toHaveLength(0);
    expect(unreadFor("sess-C")).toHaveLength(1);
    expect(unreadFor("sess-D")).toHaveLength(1);
  });

  it("per-slot expiry frees one slot and notifies one waiter", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    claim("sess-A", { capacity: 2, ttl_seconds: 5 });
    claim("sess-B", { ttl_seconds: 600 });
    claim("sess-C", { wait: true });

    vi.setSystemTime(new Date(Date.now() + 10_000));
    repo.listLocks("/repo");

    expect(unreadFor("sess-C")).toHaveLength(1);
    expect(repo.listLocks("/repo").map((l) => l.session_id)).toEqual(["sess-B"]);
  });

  it("a slot freed by expiry keeps the inherited capacity for the next claim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    claim("sess-A", { capacity: 2, ttl_seconds: 5 });
    claim("sess-B", { ttl_seconds: 600 });

    vi.setSystemTime(new Date(Date.now() + 10_000));
    const c = claim("sess-C", { capacity: 9 });
    expect(c.ok).toBe(true);
    expect(c.capacity).toBe(2);
  });
});

describe("Repository — lock renewal via heartbeat", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "sess-A", project: "/repo" });
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("renew_locks pushes back expiry by the lock's own ttl", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const claimed = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
      ttl_seconds: 60,
    });

    vi.setSystemTime(new Date(Date.now() + 30_000));
    const hb = repo.heartbeat("sess-A", undefined, { renew_locks: true });
    expect(hb).toEqual({ ok: true, renewed_locks: 1 });

    const lock = repo.listLocks("/repo")[0];
    expect(lock.expires_at).toBe(claimed.lock!.expires_at + 30_000);
  });

  it("renew_locks does not resurrect an already-expired lock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
      ttl_seconds: 5,
    });

    vi.setSystemTime(new Date(Date.now() + 10_000));
    const hb = repo.heartbeat("sess-A", undefined, { renew_locks: true });
    expect(hb).toEqual({ ok: true, renewed_locks: 0 });
    expect(repo.listLocks("/repo")).toHaveLength(0);
  });

  it("heartbeat without renew_locks leaves lock expiry untouched", () => {
    const claimed = repo.claimResource({
      resource: "ci",
      project: "/repo",
      session_id: "sess-A",
      ttl_seconds: 60,
    });
    const hb = repo.heartbeat("sess-A");
    expect(hb).toEqual({ ok: true });
    expect(repo.listLocks("/repo")[0].expires_at).toBe(claimed.lock!.expires_at);
  });
});

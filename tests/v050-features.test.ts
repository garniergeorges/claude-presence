import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Repository, ProjectClosedError } from "../src/db/repository.js";
import { freshRepo } from "./helpers.js";
import { sessionStatus, formatInbox } from "../src/tools/helpers.js";

describe("v0.5.0 — since_id cursor", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "sess-A", project: "/repo" });
    repo.registerSession({ id: "sess-B", project: "/repo" });
  });

  afterEach(() => db.close());

  it("returns only messages with id > since_id, ascending", () => {
    const m1 = repo.broadcast({ project: "/repo", from_session: "sess-A", message: "m1" });
    const m2 = repo.broadcast({ project: "/repo", from_session: "sess-A", message: "m2" });
    const m3 = repo.broadcast({ project: "/repo", from_session: "sess-A", message: "m3" });

    const res = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: false,
      peek: true,
      since_id: m1.id,
    });
    expect(res.messages.map((m) => m.id)).toEqual([m2.id, m3.id]);
  });

  it("since_id: 0 returns everything (first boot), ascending", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "m1" });
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "m2" });
    const res = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: false,
      peek: true,
      since_id: 0,
    });
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0].message).toBe("m1");
  });

  it("max_id advances the cursor even when no message is visible (dead-window survival)", () => {
    // sess-B posts; sess-B's own read sees nothing but max_id still moves.
    const own = repo.broadcast({ project: "/repo", from_session: "sess-B", message: "mine" });
    const res = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: false,
      peek: true,
      since_id: 0,
    });
    expect(res.messages).toHaveLength(0);
    expect(res.max_id).toBe(own.id);
  });
});

describe("v0.5.0 — server-stamped identity", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
  });

  afterEach(() => db.close());

  it("stamps from_identity on broadcast and exposes it in the row", () => {
    repo.registerSession({ id: "s1", project: "/p" });
    const row = repo.broadcast({
      project: "/p",
      from_session: "s1",
      message: "hello",
      from_identity: "joao",
    });
    expect(row.from_identity).toBe("joao");
    expect(formatInbox(row).from_identity).toBe("joao");
  });

  it("stamps identity on session register and keeps it on re-register without identity", () => {
    const first = repo.registerSession({ id: "s1", project: "/p", identity: "matheus" });
    expect(first.identity).toBe("matheus");
    // Re-register without identity (e.g. no-auth heartbeat recreate) must not erase it.
    const again = repo.registerSession({ id: "s1", project: "/p" });
    expect(again.identity).toBe("matheus");
  });
});

describe("v0.5.0 — structured envelope (act/cid/fim/rt)", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "sess-A", project: "/repo" });
    repo.registerSession({ id: "sess-B", project: "/repo" });
  });

  afterEach(() => db.close());

  it("stores envelope fields and formats fim back to boolean", () => {
    const row = repo.broadcast({
      project: "/repo",
      from_session: "sess-A",
      message: "proposta",
      act: "PROPOSE",
      cid: "c-20260803-6c95",
      fim: false,
      rt: "m-6",
    });
    const out = formatInbox(row);
    expect(out.act).toBe("PROPOSE");
    expect(out.cid).toBe("c-20260803-6c95");
    expect(out.fim).toBe(false);
    expect(out.rt).toBe("m-6");
  });

  it("legacy broadcasts without envelope fields format them as null", () => {
    const row = repo.broadcast({
      project: "/repo",
      from_session: "sess-A",
      message: "plain",
    });
    const out = formatInbox(row);
    expect(out.act).toBeNull();
    expect(out.fim).toBeNull();
  });

  it("filters by fim: false (messages still awaiting reply)", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "open", fim: false });
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "closed", fim: true });
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "legacy" });

    const open = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: false,
      peek: true,
      fim: false,
    });
    expect(open.messages).toHaveLength(1);
    expect(open.messages[0].message).toBe("open");
  });

  it("filters by act and cid", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "a", act: "ASK", cid: "c-1" });
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "b", act: "INFO", cid: "c-1" });
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "c", act: "ASK", cid: "c-2" });

    const asks = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: false,
      peek: true,
      act: "ASK",
      cid: "c-1",
    });
    expect(asks.messages).toHaveLength(1);
    expect(asks.messages[0].message).toBe("a");
  });
});

describe("v0.5.0 — session liveness status", () => {
  it("computes active / idle / stale from heartbeat age", () => {
    const now = Date.now();
    expect(sessionStatus(now - 60_000, now)).toBe("active"); // 1min
    expect(sessionStatus(now - 10 * 60_000, now)).toBe("idle"); // 10min
    expect(sessionStatus(now - 60 * 60_000, now)).toBe("stale"); // 1h
  });
});

describe("v0.5.0 — room lifecycle (project_close)", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "sess-A", project: "room-1" });
    repo.registerSession({ id: "sess-B", project: "room-1" });
  });

  afterEach(() => db.close());

  it("close removes sessions and refuses new broadcasts/registrations", () => {
    const result = repo.closeProject({ project: "room-1", closed_by: "sess-A" });
    expect(result.closed).toBe(true);
    expect(result.sessions_removed).toBe(2);
    expect(repo.listSessions("room-1")).toHaveLength(0);

    expect(() =>
      repo.broadcast({ project: "room-1", from_session: "sess-A", message: "late" }),
    ).toThrow(ProjectClosedError);
    expect(() =>
      repo.registerSession({ id: "sess-C", project: "room-1" }),
    ).toThrow(ProjectClosedError);
  });

  it("read_inbox still drains a closed room", () => {
    repo.broadcast({ project: "room-1", from_session: "sess-A", message: "last words" });
    repo.closeProject({ project: "room-1", closed_by: "sess-A" });
    const res = repo.readInbox({
      project: "room-1",
      session_id: "sess-B",
      unread_only: false,
      peek: true,
    });
    expect(res.messages).toHaveLength(1);
  });

  it("close is idempotent and reopen undoes it", () => {
    repo.closeProject({ project: "room-1", closed_by: "sess-A" });
    const second = repo.closeProject({ project: "room-1", closed_by: "sess-B" });
    expect(second.already_closed).toBe(true);

    expect(repo.reopenProject("room-1").reopened).toBe(true);
    expect(() =>
      repo.registerSession({ id: "sess-C", project: "room-1" }),
    ).not.toThrow();
  });

  it("does not affect other projects", () => {
    repo.registerSession({ id: "other", project: "room-2" });
    repo.closeProject({ project: "room-1", closed_by: "sess-A" });
    expect(repo.listSessions("room-2")).toHaveLength(1);
    expect(() =>
      repo.broadcast({ project: "room-2", from_session: "other", message: "ok" }),
    ).not.toThrow();
  });
});

describe("v0.5.0 — broadcast push listeners", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "sess-A", project: "/repo" });
  });

  afterEach(() => db.close());

  it("notifies listeners on each broadcast and unsubscribe stops it", () => {
    const seen: number[] = [];
    const unsubscribe = repo.onBroadcast((row) => seen.push(row.id));
    const m1 = repo.broadcast({ project: "/repo", from_session: "sess-A", message: "1" });
    unsubscribe();
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "2" });
    expect(seen).toEqual([m1.id]);
  });

  it("a throwing listener never breaks the write", () => {
    repo.onBroadcast(() => {
      throw new Error("boom");
    });
    expect(() =>
      repo.broadcast({ project: "/repo", from_session: "sess-A", message: "safe" }),
    ).not.toThrow();
  });
});

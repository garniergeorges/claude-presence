import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Repository } from "../src/db/repository.js";
import { freshRepo } from "./helpers.js";

describe("inbox — direct messages, peek, priority", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "alice", project: "/repo" });
    repo.registerSession({ id: "bob", project: "/repo" });
    repo.registerSession({ id: "carol", project: "/repo" });
  });

  afterEach(() => db.close());

  it("delivers a DM only to the targeted session", () => {
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      to_session: "bob",
      message: "hi bob",
    });

    const bobInbox = repo.readInbox({ project: "/repo", session_id: "bob" });
    expect(bobInbox.messages).toHaveLength(1);
    expect(bobInbox.messages[0].to_session).toBe("bob");
    expect(bobInbox.messages[0].message).toBe("hi bob");

    const carolInbox = repo.readInbox({ project: "/repo", session_id: "carol" });
    expect(carolInbox.messages).toHaveLength(0);
    expect(carolInbox.total).toBe(0);
  });

  it("delivers broadcasts to every other session", () => {
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "everyone read this",
    });

    const bob = repo.readInbox({ project: "/repo", session_id: "bob" });
    const carol = repo.readInbox({ project: "/repo", session_id: "carol" });
    expect(bob.messages).toHaveLength(1);
    expect(carol.messages).toHaveLength(1);
    expect(bob.messages[0].to_session).toBeNull();
  });

  it("peek does not mark messages as read", () => {
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "ping",
    });

    const peek = repo.readInbox({
      project: "/repo",
      session_id: "bob",
      unread_only: true,
      peek: true,
    });
    expect(peek.messages).toHaveLength(1);
    expect(peek.unread_total).toBe(1);

    const second = repo.readInbox({
      project: "/repo",
      session_id: "bob",
      unread_only: true,
    });
    expect(second.messages).toHaveLength(1);
    expect(second.unread_total).toBe(1);

    const third = repo.readInbox({
      project: "/repo",
      session_id: "bob",
      unread_only: true,
    });
    expect(third.messages).toHaveLength(0);
    expect(third.unread_total).toBe(0);
  });

  it("stores priority and defaults to info", () => {
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "default",
    });
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "warn",
      priority: "warning",
    });
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "urgent",
      priority: "urgent",
    });

    const all = repo.readInbox({
      project: "/repo",
      session_id: "bob",
      unread_only: false,
    });
    const byMessage = Object.fromEntries(
      all.messages.map((m) => [m.message, m.priority]),
    );
    expect(byMessage.default).toBe("info");
    expect(byMessage.warn).toBe("warning");
    expect(byMessage.urgent).toBe("urgent");
  });

  it("min_priority filters out lower-priority messages", () => {
    repo.broadcast({ project: "/repo", from_session: "alice", message: "info-msg" });
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "warn-msg",
      priority: "warning",
    });
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "urgent-msg",
      priority: "urgent",
    });

    const warningsAndUp = repo.readInbox({
      project: "/repo",
      session_id: "bob",
      unread_only: false,
      min_priority: "warning",
    });
    expect(warningsAndUp.messages.map((m) => m.message).sort()).toEqual([
      "urgent-msg",
      "warn-msg",
    ]);
    expect(warningsAndUp.total).toBe(2);

    const urgentOnly = repo.readInbox({
      project: "/repo",
      session_id: "bob",
      unread_only: false,
      min_priority: "urgent",
    });
    expect(urgentOnly.messages).toHaveLength(1);
    expect(urgentOnly.messages[0].message).toBe("urgent-msg");
  });

  it("counts and visibility honor DM targeting (Carol cannot peek Bob's DMs)", () => {
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      to_session: "bob",
      message: "private",
    });
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "public",
    });

    const carol = repo.readInbox({
      project: "/repo",
      session_id: "carol",
      unread_only: false,
    });
    expect(carol.messages).toHaveLength(1);
    expect(carol.messages[0].message).toBe("public");
    expect(carol.total).toBe(1);
  });

  it("DM author is still excluded from their own inbox", () => {
    repo.broadcast({
      project: "/repo",
      from_session: "alice",
      to_session: "bob",
      message: "hi",
    });
    const aliceInbox = repo.readInbox({
      project: "/repo",
      session_id: "alice",
      unread_only: false,
    });
    expect(aliceInbox.messages).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Repository } from "../src/db/repository.js";
import { freshRepo } from "./helpers.js";

describe("Repository — broadcast inbox", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "sess-A", project: "/repo" });
    repo.registerSession({ id: "sess-B", project: "/repo" });
  });

  afterEach(() => db.close());

  it("posts and returns messages from other sessions only", () => {
    repo.broadcast({
      project: "/repo",
      from_session: "sess-A",
      message: "refactored auth module",
    });
    const res = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
    });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].from_session).toBe("sess-A");
    expect(res.messages[0].message).toBe("refactored auth module");
    expect(res.total).toBe(1);
  });

  it("excludes the author's own messages", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "m1" });
    const res = repo.readInbox({
      project: "/repo",
      session_id: "sess-A",
    });
    expect(res.messages).toHaveLength(0);
    expect(res.total).toBe(0);
  });

  it("unread_only: true hides already-read messages", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "once" });
    const firstRead = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: true,
    });
    expect(firstRead.messages).toHaveLength(1);
    expect(firstRead.unread_total).toBe(1);

    const secondRead = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: true,
    });
    expect(secondRead.messages).toHaveLength(0);
    expect(secondRead.unread_total).toBe(0);
  });

  it("unread_only: false returns the full history", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "m1" });
    repo.readInbox({ project: "/repo", session_id: "sess-B", unread_only: true });
    const all = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: false,
    });
    expect(all.messages).toHaveLength(1);
    expect(all.total).toBe(1);
  });

  it("scopes inbox per project", () => {
    repo.registerSession({ id: "sess-C", project: "/other" });
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "here" });
    repo.broadcast({ project: "/other", from_session: "sess-C", message: "there" });

    const repoInbox = repo.readInbox({ project: "/repo", session_id: "sess-B" });
    expect(repoInbox.messages).toHaveLength(1);
    expect(repoInbox.messages[0].message).toBe("here");
  });

  it("preserves tags as an array when provided", () => {
    repo.broadcast({
      project: "/repo",
      from_session: "sess-A",
      message: "heads up",
      tags: ["warning", "ci"],
    });
    const res = repo.readInbox({ project: "/repo", session_id: "sess-B" });
    expect(res.messages[0].tags).toBe('["warning","ci"]');
  });

  it("reports unread_total even when no messages are returned (already read)", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "m1" });
    repo.readInbox({ project: "/repo", session_id: "sess-B", unread_only: true });

    // Second call with unread_only: empty messages, unread_total=0,
    // but total=1 so caller can see history exists
    const second = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: true,
    });
    expect(second.messages).toHaveLength(0);
    expect(second.unread_total).toBe(0);
    expect(second.total).toBe(1);
  });
});

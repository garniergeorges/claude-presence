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
    const fromBPov = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
    });
    expect(fromBPov).toHaveLength(1);
    expect(fromBPov[0].from_session).toBe("sess-A");
    expect(fromBPov[0].message).toBe("refactored auth module");
  });

  it("excludes the author's own messages", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "m1" });
    const selfPov = repo.readInbox({
      project: "/repo",
      session_id: "sess-A",
    });
    expect(selfPov).toHaveLength(0);
  });

  it("unread_only: true hides already-read messages", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "once" });
    const firstRead = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: true,
    });
    expect(firstRead).toHaveLength(1);

    const secondRead = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: true,
    });
    expect(secondRead).toHaveLength(0);
  });

  it("unread_only: false returns the full history", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "m1" });
    repo.readInbox({ project: "/repo", session_id: "sess-B", unread_only: true });
    const all = repo.readInbox({
      project: "/repo",
      session_id: "sess-B",
      unread_only: false,
    });
    expect(all).toHaveLength(1);
  });

  it("scopes inbox per project", () => {
    repo.registerSession({ id: "sess-C", project: "/other" });
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "here" });
    repo.broadcast({ project: "/other", from_session: "sess-C", message: "there" });

    const repoInbox = repo.readInbox({ project: "/repo", session_id: "sess-B" });
    expect(repoInbox).toHaveLength(1);
    expect(repoInbox[0].message).toBe("here");
  });

  it("preserves tags as an array when provided", () => {
    repo.broadcast({
      project: "/repo",
      from_session: "sess-A",
      message: "heads up",
      tags: ["warning", "ci"],
    });
    const msgs = repo.readInbox({ project: "/repo", session_id: "sess-B" });
    expect(msgs[0].tags).toBe('["warning","ci"]');
  });
});

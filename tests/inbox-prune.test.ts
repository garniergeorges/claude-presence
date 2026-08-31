import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Repository } from "../src/db/repository.js";
import { freshRepo } from "./helpers.js";

describe("Repository — pruneOldInbox cleans up read receipts", () => {
  let repo: Repository;
  let db: Database.Database;

  const countReads = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM inbox_reads").get() as { n: number }).n;
  const countMessages = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "sess-A", project: "/repo" });
    repo.registerSession({ id: "sess-B", project: "/repo" });
  });

  afterEach(() => db.close());

  it("removes receipts whose message has been pruned", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "old news" });
    repo.readInbox({ project: "/repo", session_id: "sess-B" });

    expect(countMessages()).toBe(1);
    expect(countReads()).toBe(1);

    // Age the message past the retention window.
    db.prepare("UPDATE inbox SET created_at = 0").run();
    repo.pruneOldInbox();

    expect(countMessages()).toBe(0);
    expect(countReads()).toBe(0);
  });

  it("keeps receipts whose message is still live", () => {
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "recent" });
    repo.readInbox({ project: "/repo", session_id: "sess-B" });

    repo.pruneOldInbox();

    expect(countMessages()).toBe(1);
    expect(countReads()).toBe(1);
  });

  it("clears orphans that predate the fix, even when nothing is pruned now", () => {
    // A receipt pointing at a message id that never existed stands in for rows
    // left behind by earlier versions, which deleted messages and not receipts.
    db.prepare(
      "INSERT INTO inbox_reads (session_id, message_id, read_at) VALUES (?, ?, ?)",
    ).run("sess-B", 9999, Date.now());

    expect(countReads()).toBe(1);
    expect(repo.pruneOldInbox()).toBe(0);
    expect(countReads()).toBe(0);
  });

  it("does not drop receipts when the reader session is gone", () => {
    // Sessions re-register under a stable id, so discarding their receipts
    // would resurface already-read messages as unread.
    repo.broadcast({ project: "/repo", from_session: "sess-A", message: "still here" });
    repo.readInbox({ project: "/repo", session_id: "sess-B" });
    repo.unregisterSession("sess-B");

    repo.pruneOldInbox();

    expect(countReads()).toBe(1);
  });
});

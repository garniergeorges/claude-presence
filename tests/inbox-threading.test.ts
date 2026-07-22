import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/db/index.js";
import { Repository } from "../src/db/repository.js";
import { inboxTools } from "../src/tools/inbox.js";
import { freshRepo } from "./helpers.js";

const CLI_PATH = resolve(__dirname, "..", "dist", "cli", "index.js");

describe("Repository — inbox reply_to", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "alice", project: "/repo" });
    repo.registerSession({ id: "bob", project: "/repo" });
  });

  afterEach(() => db.close());

  it("stores reply_to and returns it on read", () => {
    const original = repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "who holds the CI?",
    });
    repo.broadcast({
      project: "/repo",
      from_session: "bob",
      to_session: "alice",
      message: "me, releasing in 5",
      reply_to: original.id,
    });

    const aliceInbox = repo.readInbox({ project: "/repo", session_id: "alice" });
    expect(aliceInbox.messages).toHaveLength(1);
    expect(aliceInbox.messages[0].reply_to).toBe(original.id);
  });

  it("defaults reply_to to null", () => {
    const row = repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "plain broadcast",
    });
    expect(row.reply_to).toBeNull();
  });

  it("getInboxMessage finds a message by id", () => {
    const row = repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "hello",
    });
    expect(repo.getInboxMessage(row.id)?.message).toBe("hello");
    expect(repo.getInboxMessage(999_999)).toBeUndefined();
  });
});

describe("broadcast tool — reply threading", () => {
  let repo: Repository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "alice", project: "/repo" });
    repo.registerSession({ id: "bob", project: "/repo" });
  });

  afterEach(() => db.close());

  function broadcastTool() {
    return inboxTools(repo).find((t) => t.name === "broadcast")!;
  }

  async function callBroadcast(args: Record<string, unknown>): Promise<any> {
    return broadcastTool().handler(args as never);
  }

  it("a reply is addressed to the original sender by default", async () => {
    const original = repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "anyone on the staging db?",
    });
    const result = await callBroadcast({
      session_id: "bob",
      project: "/repo",
      message: "yes, done in 10",
      reply_to: original.id,
    });
    expect(result.posted.to_session).toBe("alice");
    expect(result.posted.reply_to).toBe(original.id);
  });

  it("an explicit to_session wins over the default reply target", async () => {
    const original = repo.broadcast({
      project: "/repo",
      from_session: "alice",
      message: "fyi",
    });
    repo.registerSession({ id: "carol", project: "/repo" });
    const result = await callBroadcast({
      session_id: "bob",
      project: "/repo",
      to_session: "carol",
      message: "forwarding to carol",
      reply_to: original.id,
    });
    expect(result.posted.to_session).toBe("carol");
  });

  it("rejects a reply to a nonexistent message", async () => {
    const result = await callBroadcast({
      session_id: "bob",
      project: "/repo",
      message: "into the void",
      reply_to: 424242,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("reply_to_not_found");
  });

  it("rejects a reply to a message from another project", async () => {
    repo.registerSession({ id: "dave", project: "/other" });
    const foreign = repo.broadcast({
      project: "/other",
      from_session: "dave",
      message: "other project chatter",
    });
    const result = await callBroadcast({
      session_id: "bob",
      project: "/repo",
      message: "cross-project reply",
      reply_to: foreign.id,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("reply_to_not_found");
  });
});

describe("TTL configuration via environment", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-presence-ttl-"));
    dbPath = join(tmpDir, "state.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runClear(env: Record<string, string>, extra: string[] = []): any {
    const out = execFileSync(
      "node",
      [CLI_PATH, "clear", "--json", ...extra],
      {
        env: { ...process.env, CLAUDE_PRESENCE_DB: dbPath, ...env },
        encoding: "utf8",
      },
    ).trim();
    return JSON.parse(out);
  }

  function seedAged(): void {
    const db = openDatabase(dbPath);
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    db.prepare(
      "INSERT INTO sessions (id, project, started_at, last_heartbeat) VALUES (?, ?, ?, ?)",
    ).run("old-session", "/repo", twoHoursAgo, twoHoursAgo);
    db.prepare(
      "INSERT INTO inbox (project, from_session, message, created_at) VALUES (?, ?, ?, ?)",
    ).run("/repo", "old-session", "aged message", twoHoursAgo);
    db.close();
  }

  it("default TTLs keep a 2-hour-old session and message", () => {
    seedAged();
    const result = runClear({}, ["--all"]);
    expect(result.pruned_sessions).toBe(0);
    expect(result.pruned_inbox).toBe(0);
  });

  it("CLAUDE_PRESENCE_SESSION_TTL_SECONDS shortens the session TTL", () => {
    seedAged();
    const result = runClear({ CLAUDE_PRESENCE_SESSION_TTL_SECONDS: "60" });
    expect(result.pruned_sessions).toBe(1);
  });

  it("CLAUDE_PRESENCE_INBOX_RETENTION_SECONDS shortens the inbox retention", () => {
    seedAged();
    const result = runClear(
      { CLAUDE_PRESENCE_INBOX_RETENTION_SECONDS: "60" },
      ["--all"],
    );
    expect(result.pruned_inbox).toBe(1);
  });

  it("an invalid TTL value falls back to the default", () => {
    seedAged();
    const result = runClear({ CLAUDE_PRESENCE_SESSION_TTL_SECONDS: "banana" });
    expect(result.pruned_sessions).toBe(0);
  });
});

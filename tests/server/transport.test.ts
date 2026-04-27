import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/db/schema.js";
import { Repository } from "../../src/db/repository.js";
import { createMcpHttpHandler } from "../../src/server/transport.js";

describe("createMcpHttpHandler", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it("returns a callable handler", () => {
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const repo = new Repository(db);

    const handler = createMcpHttpHandler({
      repo,
      serverName: "claude-presence",
      serverVersion: "0.2.0",
    });

    expect(typeof handler).toBe("function");
  });

  it("does not throw when constructed multiple times with the same repo", () => {
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const repo = new Repository(db);

    const h1 = createMcpHttpHandler({
      repo,
      serverName: "claude-presence",
      serverVersion: "0.2.0",
    });
    const h2 = createMcpHttpHandler({
      repo,
      serverName: "claude-presence",
      serverVersion: "0.2.0",
    });
    expect(h1).not.toBe(h2);
  });
});

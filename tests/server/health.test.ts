import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/db/schema.js";
import { checkHealth } from "../../src/server/health.js";

describe("health endpoint", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it("returns ok status with a working database", () => {
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const result = checkHealth(db, "0.2.0");
    expect(result.status).toBe("ok");
    expect(result.db).toBe("ok");
    expect(result.version).toBe("0.2.0");
    expect(result.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns degraded when the database is closed", () => {
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.close();
    const result = checkHealth(db, "0.2.0");
    expect(result.status).toBe("degraded");
    expect(result.db).toBe("error");
  });
});

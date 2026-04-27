import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/db/schema.js";
import { TokenStore, hashToken, TOKEN_PREFIX } from "../../src/auth/tokens.js";

describe("TokenStore", () => {
  let db: Database.Database;
  let store: TokenStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    store = new TokenStore(db);
  });

  afterEach(() => db.close());

  it("creates a token, returns plaintext once, stores only the hash", () => {
    const created = store.create({ name: "alice", scope: "write" });

    expect(created.plaintextToken.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(created.plaintextToken.length).toBeGreaterThan(20);
    expect(created.scope).toBe("write");

    const row = store.findByName("alice");
    expect(row).toBeDefined();
    expect(row!.hashed_token).toBe(hashToken(created.plaintextToken));
    // The plaintext is NEVER stored in any column
    expect(JSON.stringify(row)).not.toContain(created.plaintextToken);
  });

  it("findByPlaintext resolves a valid token", () => {
    const created = store.create({ name: "bob", scope: "read" });
    const row = store.findByPlaintext(created.plaintextToken);
    expect(row?.name).toBe("bob");
  });

  it("findByPlaintext returns undefined for revoked tokens", () => {
    const created = store.create({ name: "carol", scope: "admin" });
    store.revoke("carol");
    expect(store.findByPlaintext(created.plaintextToken)).toBeUndefined();
  });

  it("findByPlaintext returns undefined for unknown tokens", () => {
    expect(store.findByPlaintext("cp_unknown")).toBeUndefined();
    expect(store.findByPlaintext("not-prefixed")).toBeUndefined();
  });

  it("revoke is idempotent on already-revoked tokens", () => {
    store.create({ name: "dave", scope: "read" });
    expect(store.revoke("dave")).toEqual({ revoked: true });
    expect(store.revoke("dave")).toEqual({
      revoked: false,
      reason: "already_revoked",
    });
  });

  it("revoke fails on unknown tokens", () => {
    expect(store.revoke("ghost")).toEqual({
      revoked: false,
      reason: "not_found",
    });
  });

  it("countActiveAdmins counts only non-revoked admins", () => {
    expect(store.countActiveAdmins()).toBe(0);
    store.create({ name: "a1", scope: "admin" });
    store.create({ name: "a2", scope: "admin" });
    store.create({ name: "w1", scope: "write" });
    expect(store.countActiveAdmins()).toBe(2);
    store.revoke("a1");
    expect(store.countActiveAdmins()).toBe(1);
  });

  it("touchLastUsed updates the timestamp", () => {
    const created = store.create({ name: "ed", scope: "read" });
    expect(store.findByName("ed")!.last_used_at).toBeNull();
    store.touchLastUsed(created.id);
    const used = store.findByName("ed")!.last_used_at;
    expect(used).not.toBeNull();
    expect(used).toBeGreaterThan(0);
  });

  it("parseOverrides reads the JSON column safely", () => {
    store.create({
      name: "scoped",
      scope: "write",
      toolOverrides: ["resource_claim", "broadcast"],
    });
    const row = store.findByName("scoped")!;
    expect(store.parseOverrides(row)).toEqual([
      "resource_claim",
      "broadcast",
    ]);
  });
});

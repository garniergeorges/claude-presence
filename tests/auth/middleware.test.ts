import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { IncomingMessage } from "node:http";
import { SCHEMA_SQL } from "../../src/db/schema.js";
import { TokenStore } from "../../src/auth/tokens.js";
import { TokenAuthenticator } from "../../src/auth/middleware.js";

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("TokenAuthenticator", () => {
  let db: Database.Database;
  let store: TokenStore;
  let auth: TokenAuthenticator;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    store = new TokenStore(db);
    auth = new TokenAuthenticator(store);
  });

  afterEach(() => db.close());

  it("rejects missing Authorization header", () => {
    const result = auth.authenticate(fakeReq({}));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("missing_authorization");
  });

  it("rejects non-Bearer schemes", () => {
    const result = auth.authenticate(
      fakeReq({ authorization: "Basic abc=" }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_authorization_scheme");
  });

  it("rejects unknown bearer tokens", () => {
    const result = auth.authenticate(
      fakeReq({ authorization: "Bearer cp_unknown" }),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("invalid_token");
  });

  it("accepts a valid token and returns the auth context", () => {
    const created = store.create({ name: "alice", scope: "write" });
    const result = auth.authenticate(
      fakeReq({ authorization: `Bearer ${created.plaintextToken}` }),
    );
    expect(result.ok).toBe(true);
    expect(result.context?.scope).toBe("write");
    expect(result.context?.token.name).toBe("alice");
    expect(result.context?.ipAddress).toBe("127.0.0.1");
  });

  it("rejects revoked tokens immediately after revocation", () => {
    const created = store.create({ name: "bob", scope: "read" });
    const ok = auth.authenticate(
      fakeReq({ authorization: `Bearer ${created.plaintextToken}` }),
    );
    expect(ok.ok).toBe(true);

    store.revoke("bob");
    auth.invalidateAll(); // simulate cache invalidation hook

    const after = auth.authenticate(
      fakeReq({ authorization: `Bearer ${created.plaintextToken}` }),
    );
    expect(after.ok).toBe(false);
  });

  it("loads tool overrides into the auth context", () => {
    const created = store.create({
      name: "ci-bot",
      scope: "write",
      toolOverrides: ["resource_claim", "resource_release"],
    });
    const result = auth.authenticate(
      fakeReq({ authorization: `Bearer ${created.plaintextToken}` }),
    );
    expect(result.context?.toolOverrides).toEqual([
      "resource_claim",
      "resource_release",
    ]);
  });
});

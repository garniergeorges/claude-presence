import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Scope, ToolName } from "./rbac.js";

export interface TokenRow {
  id: string;
  name: string;
  hashed_token: string;
  scope: Scope;
  tool_overrides: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  notes: string | null;
}

export interface TokenInput {
  name: string;
  scope: Scope;
  toolOverrides?: ToolName[] | null;
  notes?: string | null;
}

export interface CreatedToken {
  id: string;
  name: string;
  scope: Scope;
  plaintextToken: string;
  createdAt: number;
}

export const TOKEN_PREFIX = "cp_";

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function generatePlaintextToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export class TokenStore {
  constructor(private readonly db: Database.Database) {}

  create(input: TokenInput): CreatedToken {
    const id = randomUUID();
    const plaintext = generatePlaintextToken();
    const hashed = hashToken(plaintext);
    const overrides = input.toolOverrides && input.toolOverrides.length > 0
      ? JSON.stringify(input.toolOverrides)
      : null;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO team_tokens (id, name, hashed_token, scope, tool_overrides, created_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, hashed, input.scope, overrides, now, input.notes ?? null);

    return {
      id,
      name: input.name,
      scope: input.scope,
      plaintextToken: plaintext,
      createdAt: now,
    };
  }

  findByPlaintext(plaintext: string): TokenRow | undefined {
    if (!plaintext.startsWith(TOKEN_PREFIX)) return undefined;
    const hashed = hashToken(plaintext);
    const row = this.db
      .prepare("SELECT * FROM team_tokens WHERE hashed_token = ?")
      .get(hashed) as TokenRow | undefined;
    if (!row) return undefined;
    if (row.revoked_at !== null) return undefined;
    return row;
  }

  findByName(name: string): TokenRow | undefined {
    return this.db
      .prepare("SELECT * FROM team_tokens WHERE name = ?")
      .get(name) as TokenRow | undefined;
  }

  list(): TokenRow[] {
    return this.db
      .prepare("SELECT * FROM team_tokens ORDER BY created_at DESC")
      .all() as TokenRow[];
  }

  revoke(name: string): { revoked: boolean; reason?: string } {
    const row = this.findByName(name);
    if (!row) return { revoked: false, reason: "not_found" };
    if (row.revoked_at !== null) return { revoked: false, reason: "already_revoked" };
    this.db
      .prepare("UPDATE team_tokens SET revoked_at = ? WHERE id = ?")
      .run(Date.now(), row.id);
    return { revoked: true };
  }

  touchLastUsed(id: string): void {
    this.db
      .prepare("UPDATE team_tokens SET last_used_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  countActiveAdmins(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM team_tokens WHERE scope = 'admin' AND revoked_at IS NULL",
      )
      .get() as { n: number };
    return row.n;
  }

  parseOverrides(row: TokenRow): ToolName[] | null {
    if (!row.tool_overrides) return null;
    try {
      return JSON.parse(row.tool_overrides) as ToolName[];
    } catch {
      return null;
    }
  }
}

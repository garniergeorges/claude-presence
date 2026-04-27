import type { IncomingMessage, ServerResponse } from "node:http";
import type { TokenStore, TokenRow } from "./tokens.js";
import type { Scope, ToolName } from "./rbac.js";

export interface AuthContext {
  token: TokenRow;
  scope: Scope;
  toolOverrides: ToolName[] | null;
  ipAddress: string | null;
}

export interface AuthResult {
  ok: boolean;
  context?: AuthContext;
  status?: number;
  error?: string;
}

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  expiresAt: number;
  result: AuthResult;
}

export class TokenAuthenticator {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly store: TokenStore) {}

  invalidateAll(): void {
    this.cache.clear();
  }

  authenticate(req: IncomingMessage): AuthResult {
    const header = req.headers["authorization"] || req.headers["Authorization"];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || typeof value !== "string") {
      return { ok: false, status: 401, error: "missing_authorization" };
    }
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    if (!match) {
      return { ok: false, status: 401, error: "invalid_authorization_scheme" };
    }
    const plaintext = match[1].trim();

    const cached = this.cache.get(plaintext);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const row = this.store.findByPlaintext(plaintext);
    if (!row) {
      const result: AuthResult = { ok: false, status: 401, error: "invalid_token" };
      // Do not cache failures (avoid leaking timing of valid hashes); skip cache.
      return result;
    }

    const ipAddress = (req.socket?.remoteAddress as string | undefined) ?? null;
    const context: AuthContext = {
      token: row,
      scope: row.scope,
      toolOverrides: this.store.parseOverrides(row),
      ipAddress,
    };

    const result: AuthResult = { ok: true, context };
    this.cache.set(plaintext, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    this.store.touchLastUsed(row.id);
    return result;
  }
}

export function writeAuthError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

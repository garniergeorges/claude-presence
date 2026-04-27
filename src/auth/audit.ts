import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type AuditStatus = "ok" | "error" | "denied";

export interface AuditEntry {
  tokenId: string | null;
  toolName: string;
  args?: unknown;
  status: AuditStatus;
  ipAddress?: string | null;
  durationMs?: number | null;
}

export class AuditLogger {
  constructor(private readonly db: Database.Database) {}

  private hashArgs(args: unknown): string | null {
    if (args === undefined || args === null) return null;
    try {
      const serialized = JSON.stringify(args);
      return createHash("sha256").update(serialized).digest("hex").slice(0, 32);
    } catch {
      return null;
    }
  }

  log(entry: AuditEntry): void {
    this.db.prepare(`
      INSERT INTO audit_log (timestamp, token_id, tool_name, args_hash, result_status, ip_address, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      entry.tokenId,
      entry.toolName,
      this.hashArgs(entry.args),
      entry.status,
      entry.ipAddress ?? null,
      entry.durationMs ?? null,
    );
  }

  recent(limit = 50): Array<{
    id: number;
    timestamp: number;
    token_id: string | null;
    tool_name: string;
    result_status: AuditStatus;
  }> {
    return this.db
      .prepare(
        `SELECT id, timestamp, token_id, tool_name, result_status
         FROM audit_log ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      timestamp: number;
      token_id: string | null;
      tool_name: string;
      result_status: AuditStatus;
    }>;
  }
}

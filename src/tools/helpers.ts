import type { z, ZodRawShape } from "zod";
import type { InboxRow, ResourceLockRow, SessionRow } from "../db/index.js";

export interface McpTool<TShape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputShape: TShape;
  handler: (args: z.objectOutputType<TShape, z.ZodTypeAny>) => Promise<unknown>;
}

function isoOrNull(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

export function formatSession(row: SessionRow) {
  return {
    id: row.id,
    project: row.project,
    branch: row.branch,
    intent: row.intent,
    pid: row.pid,
    hostname: row.hostname,
    started_at: isoOrNull(row.started_at),
    last_heartbeat: isoOrNull(row.last_heartbeat),
    age_seconds: Math.round((Date.now() - row.started_at) / 1000),
    metadata: row.metadata ? safeParse(row.metadata) : null,
  };
}

export function formatLock(row: ResourceLockRow) {
  return {
    resource: row.resource,
    project: row.project,
    held_by: row.session_id,
    branch: row.branch,
    reason: row.reason,
    acquired_at: isoOrNull(row.acquired_at),
    expires_at: isoOrNull(row.expires_at),
    ttl_remaining_seconds: Math.max(
      0,
      Math.round((row.expires_at - Date.now()) / 1000),
    ),
  };
}

export function formatInbox(row: InboxRow) {
  return {
    id: row.id,
    project: row.project,
    from_session: row.from_session,
    from_branch: row.from_branch,
    to_session: row.to_session,
    priority: row.priority,
    message: row.message,
    tags: row.tags ? safeParse(row.tags) : null,
    created_at: isoOrNull(row.created_at),
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

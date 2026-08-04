import type { z, ZodRawShape } from "zod";
import type { InboxRow, ResourceLockRow, SessionRow } from "../db/index.js";

/**
 * Per-call metadata injected by the transport layer, derived from the auth
 * token — never from client-supplied arguments. Absent in no-auth mode.
 */
export interface ToolCallMeta {
  identity: string | null;
}

export interface McpTool<TShape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputShape: TShape;
  handler: (
    args: z.objectOutputType<TShape, z.ZodTypeAny>,
    meta?: ToolCallMeta,
  ) => Promise<unknown>;
}

function isoOrNull(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

/** Server-computed liveness so "online" stops being client folklore. */
export type SessionStatus = "active" | "idle" | "stale";
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const IDLE_WINDOW_MS = 30 * 60 * 1000;

export function sessionStatus(lastHeartbeatMs: number, nowMs = Date.now()): SessionStatus {
  const age = nowMs - lastHeartbeatMs;
  if (age <= ACTIVE_WINDOW_MS) return "active";
  if (age <= IDLE_WINDOW_MS) return "idle";
  return "stale";
}

export function formatSession(row: SessionRow) {
  const now = Date.now();
  return {
    id: row.id,
    project: row.project,
    branch: row.branch,
    intent: row.intent,
    pid: row.pid,
    hostname: row.hostname,
    identity: row.identity,
    started_at: isoOrNull(row.started_at),
    last_heartbeat: isoOrNull(row.last_heartbeat),
    status: sessionStatus(row.last_heartbeat, now),
    last_heartbeat_age_seconds: Math.round((now - row.last_heartbeat) / 1000),
    age_seconds: Math.round((now - row.started_at) / 1000),
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
    from_identity: row.from_identity,
    to_session: row.to_session,
    priority: row.priority,
    message: row.message,
    tags: row.tags ? safeParse(row.tags) : null,
    act: row.act,
    cid: row.cid,
    fim: row.fim === null || row.fim === undefined ? null : row.fim === 1,
    rt: row.rt,
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

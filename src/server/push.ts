import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { Repository } from "../db/repository.js";
import { formatInbox } from "../tools/helpers.js";
import type { InboxRow } from "../db/index.js";
import { log } from "./logger.js";

export interface PushAuthResult {
  ok: boolean;
  error?: string;
}

export interface PushGatewayOptions {
  repo: Repository;
  /**
   * Verifies the upgrade request. Checks the Authorization header first;
   * WS clients that cannot set headers (e.g. Claude Code's Monitor tool)
   * pass ?token= instead. null = no-auth mode.
   */
  verify: ((req: IncomingMessage) => PushAuthResult) | null;
}

interface Subscriber {
  ws: WebSocket;
  project: string;
  sessionId: string;
  alive: boolean;
}

const PING_INTERVAL_MS = 30_000;

/**
 * WebSocket push for the inbox: GET /subscribe?project=X&session_id=Y[&since_id=N][&token=T]
 *
 * Replaces poll loops: each broadcast visible to the subscriber becomes one
 * JSON text frame {type:"message", message:{...}} the moment it is posted.
 * since_id replays what arrived while the subscriber was away (the dead
 * window), then live frames follow — no gap, no client-side cursor guessing.
 * Frames:
 *   {type:"hello", project, session_id, max_id, replayed}
 *   {type:"message", message: <formatInbox shape>}
 */
export function createPushGateway(options: PushGatewayOptions) {
  const wss = new WebSocketServer({ noServer: true });
  const subscribers = new Set<Subscriber>();

  const unsubscribeRepo = options.repo.onBroadcast((row: InboxRow) => {
    for (const sub of subscribers) {
      if (row.project !== sub.project) continue;
      // Same visibility rule as read_inbox: own posts excluded, direct
      // messages only to their target.
      if (row.from_session === sub.sessionId) continue;
      if (row.to_session !== null && row.to_session !== sub.sessionId) continue;
      try {
        sub.ws.send(
          JSON.stringify({ type: "message", message: formatInbox(row) }),
        );
      } catch {
        // socket dying; the ping sweep will reap it
      }
    }
  });

  const pingTimer = setInterval(() => {
    for (const sub of subscribers) {
      if (!sub.alive) {
        sub.ws.terminate();
        subscribers.delete(sub);
        continue;
      }
      sub.alive = false;
      try {
        sub.ws.ping();
      } catch {
        // reaped next sweep
      }
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();

  function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const url = new URL(req.url || "/", "http://localhost");

    if (options.verify) {
      const result = options.verify(req);
      if (!result.ok) {
        socket.write(
          `HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n` +
            JSON.stringify({ error: result.error ?? "unauthorized" }),
        );
        socket.destroy();
        return;
      }
    }

    const project = url.searchParams.get("project");
    const sessionId = url.searchParams.get("session_id");
    if (!project || !sessionId) {
      socket.write(
        `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n` +
          JSON.stringify({ error: "project and session_id query params are required" }),
      );
      socket.destroy();
      return;
    }
    const sinceIdRaw = url.searchParams.get("since_id");
    const sinceId = sinceIdRaw !== null ? Number(sinceIdRaw) : null;
    if (sinceId !== null && (!Number.isInteger(sinceId) || sinceId < 0)) {
      socket.write(
        `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n` +
          JSON.stringify({ error: "since_id must be a non-negative integer" }),
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const sub: Subscriber = { ws, project, sessionId, alive: true };
      subscribers.add(sub);
      ws.on("pong", () => {
        sub.alive = true;
      });
      ws.on("close", () => {
        subscribers.delete(sub);
      });
      ws.on("error", (err) => {
        log.warn("push subscriber error", { message: err.message });
        subscribers.delete(sub);
      });

      // Replay the dead window BEFORE live frames: peek (never consumes
      // read-state) + ascending cursor. Then the hello reports max_id so the
      // client can persist its cursor even if the replay was empty.
      let replayed = 0;
      let maxId = 0;
      try {
        const result = options.repo.readInbox({
          project,
          session_id: sessionId,
          unread_only: false,
          peek: true,
          since_id: sinceId ?? undefined,
          limit: sinceId !== null ? 200 : 1,
        });
        maxId = result.max_id;
        if (sinceId !== null) {
          for (const row of result.messages) {
            ws.send(JSON.stringify({ type: "message", message: formatInbox(row) }));
            replayed++;
          }
        }
      } catch (err) {
        log.warn("push replay failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      ws.send(
        JSON.stringify({
          type: "hello",
          project,
          session_id: sessionId,
          max_id: maxId,
          replayed,
        }),
      );
      log.debug("push subscriber connected", { project, sessionId, replayed });
    });
  }

  function close(): void {
    clearInterval(pingTimer);
    unsubscribeRepo();
    for (const sub of subscribers) {
      try {
        sub.ws.close(1001, "server shutting down");
      } catch {
        // ignore
      }
    }
    subscribers.clear();
    wss.close();
  }

  return { handleUpgrade, close, subscriberCount: () => subscribers.size };
}

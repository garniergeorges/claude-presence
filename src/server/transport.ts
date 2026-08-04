import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Repository } from "../db/repository.js";
import { registerAllTools } from "../tools/registry.js";
import { registerGuardedTools, type GuardedToolContext } from "../auth/tool-guard.js";
import type { AuditLogger } from "../auth/audit.js";
import type { AuthContext } from "../auth/middleware.js";
import { log } from "./logger.js";

interface ServerEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** Mutable: updated on every authenticated request before handleRequest */
  currentAuth: AuthContext | null;
  /**
   * The response of the session's current standalone SSE stream (GET /mcp).
   * Tracked so a reconnect can evict a stale stream: when the old TCP
   * connection dies silently (laptop sleep, network switch) the SDK never
   * sees 'close', keeps the stream mapped, and answers every new GET with
   * 409 "Only one SSE stream is allowed per session" — permanent reconnect
   * loop. See deploy logs 2026-06-07/2026-06-11.
   */
  sseRes: ServerResponse | null;
}

export interface McpHttpHandlerOptions {
  repo: Repository;
  serverName: string;
  serverVersion: string;
  instructions?: string;
  /** When set, all tool calls are guarded by this auth context provider */
  audit?: AuditLogger;
}

/**
 * Creates an HTTP handler that multiplexes MCP sessions over Streamable HTTP.
 * Each MCP session gets its own McpServer + transport pair, keyed by the
 * mcp-session-id header (set by the SDK on the initialize response).
 *
 * Auth: when `audit` is supplied, tools are wrapped with permission checks.
 * The caller must set `entry.currentAuth` before invoking handleRequest.
 */
export function createMcpHttpHandler(options: McpHttpHandlerOptions) {
  const sessions = new Map<string, ServerEntry>();
  const guarded = options.audit !== undefined;

  function buildEntry(): ServerEntry {
    const server = new McpServer(
      { name: options.serverName, version: options.serverVersion },
      options.instructions ? { instructions: options.instructions } : {},
    );

    const entry: ServerEntry = {
      server,
      transport: undefined as unknown as StreamableHTTPServerTransport,
      currentAuth: null,
      sseRes: null,
    };

    if (guarded && options.audit) {
      registerGuardedTools(server, options.repo, () => {
        if (!entry.currentAuth) return null;
        const ctx: GuardedToolContext = {
          permissions: {
            scope: entry.currentAuth.scope,
            toolOverrides: entry.currentAuth.toolOverrides,
          },
          tokenId: entry.currentAuth.token.id,
          tokenName: entry.currentAuth.token.name,
          ipAddress: entry.currentAuth.ipAddress,
          audit: options.audit!,
        };
        return ctx;
      });
    } else {
      registerAllTools(server, options.repo);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, entry);
        log.debug("session initialized", { sessionId });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && sessions.has(sid)) {
        sessions.delete(sid);
        log.debug("session closed", { sessionId: sid });
      }
    };

    transport.onerror = (err) => {
      log.error("transport error", {
        sessionId: transport.sessionId,
        message: err.message,
      });
    };

    entry.transport = transport;

    server.connect(transport).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error("server connect failed", { message });
    });

    return entry;
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    auth?: AuthContext,
  ): Promise<void> {
    try {
      const sessionId = (req.headers["mcp-session-id"] as string | undefined) || undefined;
      let entry: ServerEntry | undefined;

      if (sessionId && sessions.has(sessionId)) {
        entry = sessions.get(sessionId);
      } else {
        entry = buildEntry();
      }

      if (entry) {
        entry.currentAuth = auth ?? null;
      }

      // Evict a stale standalone SSE stream before the SDK sees the new GET.
      // Destroying the old response fires its 'close' handler inside the SDK,
      // which unmaps the stream — without this, a silently-dropped connection
      // makes every reconnect 409 until the TCP keepalive finally times out.
      if (req.method === "GET" && entry) {
        const stale = entry.sseRes;
        if (stale && stale !== res && !stale.writableEnded && !stale.destroyed) {
          log.warn("evicting stale SSE stream for reconnect", { sessionId });
          stale.destroy();
          // Let the SDK process the 'close' event before handling the new GET.
          await new Promise((resolve) => setImmediate(resolve));
        }
        entry.sseRes = res;
        res.on("close", () => {
          if (entry!.sseRes === res) entry!.sseRes = null;
        });
      }

      const body = req.method === "POST" ? await readBody(req) : undefined;
      await entry!.transport.handleRequest(req, res, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("http handler failed", { message });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal", message }));
      } else {
        res.end();
      }
    }
  };
}

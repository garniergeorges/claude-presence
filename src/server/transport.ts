import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Repository } from "../db/repository.js";
import { registerAllTools } from "../tools/registry.js";
import { log } from "./logger.js";

interface ServerEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface McpHttpHandlerOptions {
  repo: Repository;
  serverName: string;
  serverVersion: string;
  instructions?: string;
}

/**
 * Creates an HTTP handler that multiplexes MCP sessions over Streamable HTTP.
 * Each MCP session gets its own McpServer + transport pair, keyed by the
 * mcp-session-id header (set by the SDK on the initialize response).
 */
export function createMcpHttpHandler(options: McpHttpHandlerOptions) {
  const sessions = new Map<string, ServerEntry>();

  function buildEntry(): ServerEntry {
    const server = new McpServer(
      { name: options.serverName, version: options.serverVersion },
      options.instructions ? { instructions: options.instructions } : {},
    );
    registerAllTools(server, options.repo);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, { server, transport });
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

    server.connect(transport).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error("server connect failed", { message });
    });

    return { server, transport };
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
  ): Promise<void> {
    try {
      const sessionId = (req.headers["mcp-session-id"] as string | undefined) || undefined;
      let entry: ServerEntry | undefined;

      if (sessionId && sessions.has(sessionId)) {
        entry = sessions.get(sessionId);
      } else {
        // New session (or stateless POST). The transport will allocate the id.
        entry = buildEntry();
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

export function activeSessionCount(handler: ReturnType<typeof createMcpHttpHandler>): number {
  // Session count is internal to the closure; this helper is currently a stub
  // for future metrics instrumentation. Kept as a hook for tests.
  void handler;
  return -1;
}

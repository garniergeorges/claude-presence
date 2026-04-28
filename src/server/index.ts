#!/usr/bin/env node
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openDatabase } from "../db/index.js";
import { Repository } from "../db/repository.js";
import { TokenStore } from "../auth/tokens.js";
import { AuditLogger } from "../auth/audit.js";
import { TokenAuthenticator, writeAuthError } from "../auth/middleware.js";
import { createMcpHttpHandler } from "./transport.js";
import { handleHealth } from "./health.js";
import { log } from "./logger.js";

const PACKAGE_NAME = "claude-presence";
const PACKAGE_VERSION = "0.2.1";

const DEFAULT_PORT = 3471;
const DEFAULT_HOST = "127.0.0.1";

const SERVER_INSTRUCTIONS = `
This server coordinates Claude Code sessions across machines via HTTP MCP.

At session start, call session_register with a stable session_id and project path.
Before touching shared resources, call resource_claim. Sessions are
kept for 7 days without a heartbeat. Data stored locally in SQLite.
No telemetry, no cloud.
`.trim();

interface CliOptions {
  port: number;
  host: string;
  noAuth: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  let port = Number(process.env.PORT) || DEFAULT_PORT;
  let host = process.env.HOST || DEFAULT_HOST;
  let noAuth = process.env.CLAUDE_PRESENCE_NO_AUTH === "1";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" || a === "-p") {
      port = Number(args[++i]);
    } else if (a === "--host" || a === "-h") {
      host = args[++i];
    } else if (a === "--no-auth") {
      noAuth = true;
    } else if (a === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  return { port, host, noAuth };
}

function printHelp() {
  console.log(`${PACKAGE_NAME}-server v${PACKAGE_VERSION}

Usage:
  claude-presence-server [options]

Options:
  --port, -p <number>    HTTP port to bind (default: ${DEFAULT_PORT}, env PORT)
  --host, -h <string>    Host to bind (default: ${DEFAULT_HOST}, env HOST)
  --no-auth              Disable bearer-token auth (DANGEROUS; localhost only)
  --help                 Show this help

Endpoints:
  POST /mcp              MCP JSON-RPC endpoint (Streamable HTTP)
  GET  /healthz          Health check (200 OK + DB status)

Environment:
  CLAUDE_PRESENCE_DB         Override SQLite DB path
  CLAUDE_PRESENCE_NO_AUTH    Set to "1" to skip auth (same as --no-auth)
  LOG_LEVEL                  debug | info (default) | warn | error

Token management:
  claude-presence-server token create --name <name> --scope <read|write|admin>
  claude-presence-server token list
  claude-presence-server token revoke --name <name>
`);
}

async function main() {
  const opts = parseArgs(process.argv);

  // Sub-command dispatch: "token <action>"
  if (process.argv[2] === "token") {
    const { runTokenCommand } = await import("../cli/admin.js");
    await runTokenCommand(process.argv.slice(3));
    return;
  }

  const db = openDatabase();
  const repo = new Repository(db);
  repo.pruneAll();

  const store = new TokenStore(db);
  const audit = new AuditLogger(db);
  const authenticator = new TokenAuthenticator(store);

  if (!opts.noAuth) {
    if (store.countActiveAdmins() === 0) {
      console.error(
        `\n${PACKAGE_NAME}-server refuses to start: no active admin token in the database.\n\n` +
        `Create one with:\n` +
        `  ${PACKAGE_NAME}-server token create --name <yourname> --scope admin\n\n` +
        `Or start in unauthenticated mode (NOT recommended) with --no-auth.\n`,
      );
      process.exit(1);
    }
  }

  const mcpHandler = createMcpHttpHandler({
    repo,
    serverName: PACKAGE_NAME,
    serverVersion: PACKAGE_VERSION,
    instructions: SERVER_INSTRUCTIONS,
    audit: opts.noAuth ? undefined : audit,
  });

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";

    if (url === "/healthz" && req.method === "GET") {
      handleHealth(req, res, db, PACKAGE_VERSION);
      return;
    }

    if (url === "/mcp" || url.startsWith("/mcp?")) {
      if (opts.noAuth) {
        await mcpHandler(req, res);
        return;
      }
      const authResult = authenticator.authenticate(req);
      if (!authResult.ok || !authResult.context) {
        writeAuthError(res, authResult.status ?? 401, authResult.error ?? "unauthorized");
        return;
      }
      await mcpHandler(req, res, authResult.context);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", path: url }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, resolve);
  });

  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;
  log.info("server ready", {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    host: opts.host,
    port: boundPort,
    auth: opts.noAuth ? "disabled" : "bearer",
  });

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    httpServer.close();
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

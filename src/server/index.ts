#!/usr/bin/env node
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openDatabase } from "../db/index.js";
import { Repository } from "../db/repository.js";
import { createMcpHttpHandler } from "./transport.js";
import { handleHealth } from "./health.js";
import { log } from "./logger.js";

const PACKAGE_NAME = "claude-presence";
const PACKAGE_VERSION = "0.1.1";

const DEFAULT_PORT = 3471;
const DEFAULT_HOST = "127.0.0.1";

const SERVER_INSTRUCTIONS = `
This server coordinates Claude Code sessions across machines via HTTP MCP.

At session start, call session_register with a stable session_id and project path.
Before touching shared resources, call resource_claim. Heartbeat every 30-60s.
The data is stored locally in SQLite. No telemetry, no cloud.
`.trim();

interface CliOptions {
  port: number;
  host: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  let port = Number(process.env.PORT) || DEFAULT_PORT;
  let host = process.env.HOST || DEFAULT_HOST;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" || a === "-p") {
      port = Number(args[++i]);
    } else if (a === "--host" || a === "-h") {
      host = args[++i];
    } else if (a === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  return { port, host };
}

function printHelp() {
  console.log(`${PACKAGE_NAME}-server v${PACKAGE_VERSION}

Usage:
  claude-presence-server [options]

Options:
  --port, -p <number>    HTTP port to bind (default: ${DEFAULT_PORT}, env PORT)
  --host, -h <string>    Host to bind (default: ${DEFAULT_HOST}, env HOST)
  --help                 Show this help

Endpoints:
  POST /mcp              MCP JSON-RPC endpoint (Streamable HTTP)
  GET  /healthz          Health check (200 OK + DB status)

Environment:
  CLAUDE_PRESENCE_DB     Override SQLite DB path
  LOG_LEVEL              debug | info (default) | warn | error
`);
}

async function main() {
  const opts = parseArgs(process.argv);

  const db = openDatabase();
  const repo = new Repository(db);
  repo.pruneAll();

  const mcpHandler = createMcpHttpHandler({
    repo,
    serverName: PACKAGE_NAME,
    serverVersion: PACKAGE_VERSION,
    instructions: SERVER_INSTRUCTIONS,
  });

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";

    if (url === "/healthz" && req.method === "GET") {
      handleHealth(req, res, db, PACKAGE_VERSION);
      return;
    }

    if (url === "/mcp" || url.startsWith("/mcp?")) {
      await mcpHandler(req, res);
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

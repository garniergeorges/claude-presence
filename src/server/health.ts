import type { ServerResponse, IncomingMessage } from "node:http";
import type Database from "better-sqlite3";

interface HealthStatus {
  status: "ok" | "degraded";
  version: string;
  uptime_seconds: number;
  db: "ok" | "error";
  timestamp: string;
}

const STARTED_AT = Date.now();

export function checkHealth(db: Database.Database, version: string): HealthStatus {
  let dbStatus: "ok" | "error" = "ok";
  try {
    db.prepare("SELECT 1").get();
  } catch {
    dbStatus = "error";
  }
  return {
    status: dbStatus === "ok" ? "ok" : "degraded",
    version,
    uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000),
    db: dbStatus,
    timestamp: new Date().toISOString(),
  };
}

export function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  version: string,
): void {
  const health = checkHealth(db, version);
  const code = health.status === "ok" ? 200 : 503;
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(health));
}

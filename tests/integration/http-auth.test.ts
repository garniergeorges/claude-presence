import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function buildOnce(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["tsc"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    let err = "";
    proc.stderr.on("data", (chunk) => (err += chunk.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tsc failed with code ${code}: ${err}`));
    });
  });
}

function makeToken(dbPath: string, name: string, scope: "read" | "write" | "admin", overrides?: string[]): string {
  const args = [
    "dist/server/index.js",
    "token",
    "create",
    "--name",
    name,
    "--scope",
    scope,
  ];
  if (overrides && overrides.length > 0) {
    args.push("--tools", overrides.join(","));
  }
  const result = spawnSync("node", args, {
    env: { ...process.env, CLAUDE_PRESENCE_DB: dbPath },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`token create failed: ${result.stderr}`);
  }
  const match = /(cp_[A-Za-z0-9_-]+)/.exec(result.stdout);
  if (!match) throw new Error(`could not extract token: ${result.stdout}`);
  return match[1];
}

class HttpClient {
  private proc: ChildProcessWithoutNullStreams;
  private port = 0;
  private sessionId?: string;
  private nextId = 1;
  private ready: Promise<void>;

  constructor(dbPath: string, opts: { token?: string; noAuth?: boolean } = {}) {
    const args = ["dist/server/index.js", "--port", "0"];
    if (opts.noAuth) args.push("--no-auth");

    this.proc = spawn("node", args, {
      env: { ...process.env, CLAUDE_PRESENCE_DB: dbPath, LOG_LEVEL: "info" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.ready = new Promise<void>((resolve, reject) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.msg === "server ready" && typeof obj.port === "number") {
              this.port = obj.port;
              this.proc.stderr.off("data", onData);
              resolve();
              return;
            }
          } catch {
            // not structured
          }
        }
        buf = lines[lines.length - 1];
      };
      this.proc.stderr.on("data", onData);
      this.proc.on("error", reject);
      setTimeout(() => reject(new Error("server start timeout")), 5000);
    });
    void opts.token;
  }

  waitReady() {
    return this.ready;
  }

  private parseSse(text: string): JsonRpcResponse | null {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
    }
    return null;
  }

  async post(body: object, token?: string): Promise<{ status: number; raw: string; sessionId?: string }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      raw: await res.text(),
      sessionId: res.headers.get("mcp-session-id") || undefined,
    };
  }

  async initialize(token: string): Promise<JsonRpcResponse> {
    const res = await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1.0" },
        },
      },
      token,
    );
    if (res.sessionId) this.sessionId = res.sessionId;
    const parsed = this.parseSse(res.raw) || (res.raw ? JSON.parse(res.raw) : null);
    await this.post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      token,
    );
    return parsed!;
  }

  async callTool(name: string, args: Record<string, unknown>, token: string): Promise<JsonRpcResponse> {
    const res = await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      },
      token,
    );
    return this.parseSse(res.raw) || JSON.parse(res.raw);
  }

  async callToolParsed<T = unknown>(name: string, args: Record<string, unknown>, token: string): Promise<T> {
    const res = await this.callTool(name, args, token);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (res.result as any)?.content?.[0]?.text;
    return JSON.parse(text) as T;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.once("close", () => resolve());
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        if (!this.proc.killed) this.proc.kill("SIGKILL");
      }, 500);
    });
  }
}

describe("HTTP auth — multi-token RBAC", () => {
  let tmp: string;
  let dbPath: string;

  beforeAll(async () => {
    await buildOnce();
  }, 60_000);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cp-auth-test-"));
    dbPath = join(tmp, "state.db");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects requests without Authorization", async () => {
    makeToken(dbPath, "admin", "admin");
    const client = new HttpClient(dbPath);
    await client.waitReady();

    const res = await client.post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } },
    });
    expect(res.status).toBe(401);
    expect(res.raw).toContain("missing_authorization");

    await client.close();
  });

  it("rejects unknown bearer tokens", async () => {
    makeToken(dbPath, "admin", "admin");
    const client = new HttpClient(dbPath);
    await client.waitReady();

    const res = await client.post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      },
      "cp_invalid_token",
    );
    expect(res.status).toBe(401);
    expect(res.raw).toContain("invalid_token");

    await client.close();
  });

  it("accepts a valid admin token and allows resource_claim", async () => {
    const adminToken = makeToken(dbPath, "admin", "admin");
    const client = new HttpClient(dbPath);
    await client.waitReady();

    await client.initialize(adminToken);

    const claim = await client.callToolParsed<{ ok: boolean }>(
      "resource_claim",
      { session_id: "s-A", project: "/repo", resource: "ci" },
      adminToken,
    );
    expect(claim.ok).toBe(true);

    await client.close();
  });

  it("denies a read-only token from calling resource_claim", async () => {
    makeToken(dbPath, "admin", "admin");
    const readToken = makeToken(dbPath, "reader", "read");
    const client = new HttpClient(dbPath);
    await client.waitReady();

    await client.initialize(readToken);

    const result = await client.callTool(
      "resource_claim",
      { session_id: "s-A", project: "/repo", resource: "ci" },
      readToken,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (result.result as any)?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe("permission_denied");
    expect(parsed.scope).toBe("read");

    await client.close();
  });

  it("server refuses to start without an admin token (no --no-auth)", async () => {
    const result = spawnSync("node", ["dist/server/index.js", "--port", "0"], {
      env: { ...process.env, CLAUDE_PRESENCE_DB: dbPath },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no active admin token");
  });

  it("denies force-release for non-admin tokens", async () => {
    const adminToken = makeToken(dbPath, "admin", "admin");
    const writeToken = makeToken(dbPath, "writer", "write");
    const client = new HttpClient(dbPath);
    await client.waitReady();

    // Admin claims first
    await client.initialize(adminToken);
    await client.callToolParsed(
      "resource_claim",
      { session_id: "s-admin", project: "/repo", resource: "ci" },
      adminToken,
    );

    // Writer tries to force-release
    const result = await client.callTool(
      "resource_release",
      { session_id: "s-writer", project: "/repo", resource: "ci", force: true },
      writeToken,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (result.result as any)?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe("force_release_requires_admin");

    await client.close();
  });
});

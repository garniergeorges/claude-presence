import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
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

class HttpMcpClient {
  private proc: ChildProcessWithoutNullStreams;
  private port = 0;
  private sessionId?: string;
  private nextId = 1;
  private ready: Promise<void>;

  constructor(dbPath: string) {
    this.proc = spawn("node", ["dist/server/index.js", "--port", "0"], {
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
            // not a structured log line
          }
        }
        buf = lines[lines.length - 1];
      };
      this.proc.stderr.on("data", onData);
      this.proc.on("error", reject);
      setTimeout(() => reject(new Error("server start timeout")), 5000);
    });
  }

  async waitReady(): Promise<void> {
    await this.ready;
  }

  private async post(body: object, includeSession = true): Promise<{ status: number; body: string; sessionId?: string }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (includeSession && this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text, sessionId: res.headers.get("mcp-session-id") || undefined };
  }

  /** Parse SSE-formatted body: "event: message\ndata: {...}\n" */
  private parseSse(text: string): JsonRpcResponse | null {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        return JSON.parse(line.slice(6));
      }
    }
    return null;
  }

  async initialize(): Promise<JsonRpcResponse> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest-http", version: "1.0" },
      },
    }, false);

    if (res.sessionId) this.sessionId = res.sessionId;
    const parsed = this.parseSse(res.body) || (res.body ? JSON.parse(res.body) : null);
    if (!parsed) throw new Error(`bad initialize response: ${res.body}`);

    // Send initialized notification (no response expected)
    await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    return parsed;
  }

  async listTools(): Promise<JsonRpcResponse> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/list",
    });
    const parsed = this.parseSse(res.body) || JSON.parse(res.body);
    return parsed;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const parsed = this.parseSse(res.body) || JSON.parse(res.body);
    return parsed;
  }

  async callToolParsed<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.callTool(name, args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (res.result as any)?.content?.[0]?.text;
    return JSON.parse(text) as T;
  }

  async healthz(): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${this.port}/healthz`);
    return { status: res.status, json: await res.json() };
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

describe("HTTP MCP server — stdio integration", () => {
  let tmp: string;
  let dbPath: string;
  let client: HttpMcpClient;

  beforeAll(async () => {
    await buildOnce();
  }, 60_000);

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cp-http-test-"));
    dbPath = join(tmp, "state.db");
    client = new HttpMcpClient(dbPath);
    await client.waitReady();
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("healthz responds 200 with ok status", async () => {
    const res = await client.healthz();
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("ok");
    expect(res.json.db).toBe("ok");
  });

  it("initialize handshake returns serverInfo with the project name", async () => {
    const res = await client.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (res.result as any)?.serverInfo;
    expect(info?.name).toBe("claude-presence");
  });

  it("tools/list exposes all 9 MCP tools", async () => {
    await client.initialize();
    const res = await client.listTools();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (res.result as any)?.tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "broadcast",
        "read_inbox",
        "resource_claim",
        "resource_list",
        "resource_release",
        "session_heartbeat",
        "session_list",
        "session_register",
        "session_unregister",
      ].sort(),
    );
  });

  it("end-to-end: register → claim → release works over HTTP", async () => {
    await client.initialize();

    const reg = await client.callToolParsed<{ registered: { id: string } }>(
      "session_register",
      { session_id: "http-A", project: "/repo", branch: "feat/x" },
    );
    expect(reg.registered.id).toBe("http-A");

    const claim = await client.callToolParsed<{ ok: boolean }>("resource_claim", {
      session_id: "http-A",
      project: "/repo",
      resource: "ci",
      reason: "smoke",
    });
    expect(claim.ok).toBe(true);

    const release = await client.callToolParsed<{ released: boolean }>(
      "resource_release",
      { session_id: "http-A", project: "/repo", resource: "ci" },
    );
    expect(release.released).toBe(true);
  });
});

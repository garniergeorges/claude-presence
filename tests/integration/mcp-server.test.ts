import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, Interface } from "node:readline";
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

class McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private rl: Interface;
  private nextId = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();

  constructor(dbPath: string) {
    this.proc = spawn("node", ["dist/index.js"], {
      env: { ...process.env, CLAUDE_PRESENCE_DB: dbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const resolver = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          resolver(msg);
        }
      } catch {
        // non-JSON log, ignore
      }
    });
    // Silence stderr (server logs to stderr on startup)
    this.proc.stderr.on("data", () => {});
  }

  async initialize(): Promise<JsonRpcResponse> {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async listTools(): Promise<JsonRpcResponse> {
    return this.request("tools/list");
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    return this.request("tools/call", { name, arguments: args });
  }

  async callToolParsed<T = unknown>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.callTool(name, args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (res.result as any)?.content?.[0]?.text;
    return JSON.parse(content) as T;
  }

  private request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout on ${method}`));
        }
      }, 5000);
    });
  }

  private notify(method: string, params?: Record<string, unknown>) {
    const payload = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
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

describe("MCP server — stdio integration", () => {
  let tmpDir: string;
  let dbPath: string;
  let client: McpClient;

  beforeAll(async () => {
    // Compile TypeScript once before running the subprocess
    await buildOnce();
  }, 60_000);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-presence-test-"));
    dbPath = join(tmpDir, "state.db");
    client = new McpClient(dbPath);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handshakes and reports claude-presence server info", async () => {
    const res = await client.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverInfo = (res.result as any)?.serverInfo;
    expect(serverInfo?.name).toBe("claude-presence");
  });

  it("exposes all 9 tools", async () => {
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

  it("two sessions racing for 'ci' → second gets ok=false with holder info", async () => {
    await client.initialize();

    await client.callToolParsed("session_register", {
      session_id: "sess-A",
      project: "/repo",
      branch: "feat/x",
    });
    await client.callToolParsed("session_register", {
      session_id: "sess-B",
      project: "/repo",
      branch: "fix/y",
    });

    const a = await client.callToolParsed<{ ok: boolean }>("resource_claim", {
      session_id: "sess-A",
      project: "/repo",
      resource: "ci",
      reason: "pushing feat/x",
    });
    expect(a.ok).toBe(true);

    const b = await client.callToolParsed<{
      ok: boolean;
      held_by: { held_by: string };
    }>("resource_claim", {
      session_id: "sess-B",
      project: "/repo",
      resource: "ci",
      reason: "pushing fix/y",
    });
    expect(b.ok).toBe(false);
    expect(b.held_by.held_by).toBe("sess-A");

    // After release, B should succeed
    const released = await client.callToolParsed<{ released: boolean }>(
      "resource_release",
      { session_id: "sess-A", project: "/repo", resource: "ci" },
    );
    expect(released.released).toBe(true);

    const bRetry = await client.callToolParsed<{ ok: boolean }>(
      "resource_claim",
      { session_id: "sess-B", project: "/repo", resource: "ci" },
    );
    expect(bRetry.ok).toBe(true);
  });
});

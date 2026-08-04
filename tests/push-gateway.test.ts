import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import type Database from "better-sqlite3";
import { Repository } from "../src/db/repository.js";
import { createPushGateway } from "../src/server/push.js";
import { freshRepo } from "./helpers.js";

interface Frame {
  type: string;
  [k: string]: unknown;
}

function collectFrames(ws: WebSocket, sink: Frame[]): void {
  ws.on("message", (data) => {
    sink.push(JSON.parse(String(data)) as Frame);
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timed out"));
      }
    }, 10);
  });
}

describe("v0.5.0 — WS push gateway (/subscribe)", () => {
  let repo: Repository;
  let db: Database.Database;
  let server: Server;
  let gateway: ReturnType<typeof createPushGateway>;
  let port: number;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ({ repo, db } = freshRepo());
    repo.registerSession({ id: "peer", project: "room-x" });
    repo.registerSession({ id: "me", project: "room-x" });

    gateway = createPushGateway({ repo, verify: null });
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (req, socket, head) => {
      const url = req.url || "/";
      if (url.startsWith("/subscribe")) {
        gateway.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    sockets.length = 0;
    gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  function connect(query: string): { ws: WebSocket; frames: Frame[] } {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/subscribe?${query}`);
    sockets.push(ws);
    const frames: Frame[] = [];
    collectFrames(ws, frames);
    return { ws, frames };
  }

  it("sends hello and then pushes live broadcasts", async () => {
    const { frames } = connect("project=room-x&session_id=me");
    await waitFor(() => frames.some((f) => f.type === "hello"));

    repo.broadcast({ project: "room-x", from_session: "peer", message: "live!" });
    await waitFor(() => frames.some((f) => f.type === "message"));

    const msg = frames.find((f) => f.type === "message") as Frame & {
      message: { message: string; from_session: string };
    };
    expect(msg.message.message).toBe("live!");
    expect(msg.message.from_session).toBe("peer");
  });

  it("replays the dead window when since_id is passed (no lost messages)", async () => {
    // Messages arrive while nobody is connected — the dead window.
    const m1 = repo.broadcast({ project: "room-x", from_session: "peer", message: "missed-1" });
    repo.broadcast({ project: "room-x", from_session: "peer", message: "missed-2" });

    const { frames } = connect(`project=room-x&session_id=me&since_id=${m1.id - 1}`);
    await waitFor(() => frames.some((f) => f.type === "hello"));

    const texts = frames
      .filter((f) => f.type === "message")
      .map((f) => (f as Frame & { message: { message: string } }).message.message);
    expect(texts).toEqual(["missed-1", "missed-2"]);

    const hello = frames.find((f) => f.type === "hello") as Frame & {
      replayed: number;
      max_id: number;
    };
    expect(hello.replayed).toBe(2);
    expect(hello.max_id).toBeGreaterThanOrEqual(m1.id + 1);
  });

  it("does not push my own posts nor direct messages addressed to others", async () => {
    const { frames } = connect("project=room-x&session_id=me");
    await waitFor(() => frames.some((f) => f.type === "hello"));

    repo.broadcast({ project: "room-x", from_session: "me", message: "own post" });
    repo.broadcast({
      project: "room-x",
      from_session: "peer",
      to_session: "someone-else",
      message: "not for me",
    });
    repo.broadcast({ project: "room-x", from_session: "peer", message: "for me" });
    await waitFor(() => frames.some((f) => f.type === "message"));

    const texts = frames
      .filter((f) => f.type === "message")
      .map((f) => (f as Frame & { message: { message: string } }).message.message);
    expect(texts).toEqual(["for me"]);
  });

  it("ignores broadcasts from other projects", async () => {
    repo.registerSession({ id: "other", project: "room-y" });
    const { frames } = connect("project=room-x&session_id=me");
    await waitFor(() => frames.some((f) => f.type === "hello"));

    repo.broadcast({ project: "room-y", from_session: "other", message: "wrong room" });
    repo.broadcast({ project: "room-x", from_session: "peer", message: "right room" });
    await waitFor(() => frames.some((f) => f.type === "message"));

    const texts = frames
      .filter((f) => f.type === "message")
      .map((f) => (f as Frame & { message: { message: string } }).message.message);
    expect(texts).toEqual(["right room"]);
  });

  it("rejects the upgrade without project/session_id", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/subscribe?project=only`);
    sockets.push(ws);
    const failed = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("open", () => resolve(false));
    });
    expect(failed).toBe(true);
  });
});

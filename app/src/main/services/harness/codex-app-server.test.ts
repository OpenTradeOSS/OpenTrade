import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { CodexClient, codexListenUrl } from "./codex-app-server";

/**
 * A scripted stand-in for `codex app-server` on a unix socket: WS-over-UDS,
 * JSON-RPC, driven by a per-test `script` mapping request method → responder.
 * Replies the CLIENT sends to server-initiated requests land in `replies`.
 */
type Responder = (
  msg: { id: number; method: string; params: unknown },
  send: (m: unknown) => void,
) => void;

const homes: string[] = [];
const servers: Server[] = [];

function mockServer(script: Record<string, Responder>) {
  const dir = mkdtempSync(join(tmpdir(), "codex-mock-"));
  homes.push(dir);
  const sock = join(dir, "app-server-control.sock");
  const replies: Array<{ id: number; result?: unknown; error?: unknown }> = [];
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => {
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === undefined && msg.id !== undefined) {
        replies.push(msg); // the client answering a server-initiated request
        return;
      }
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "mock" } });
        return;
      }
      if (msg.id === undefined) return; // notifications (initialized)
      const r = script[msg.method];
      if (r) r(msg, send);
      else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no script" } });
    });
  });
  http.listen(sock);
  servers.push(http);
  return { sock, replies };
}

function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const THREAD = "t-1";
const idleThread = { thread: { id: THREAD, status: { type: "idle" } } };

test("normalizes Windows socket paths for the Codex listen URL", () => {
  const sock = "C:\\Users\\Jane Doe\\app-server-control.sock";
  expect(codexListenUrl(sock)).toBe("unix://C:/Users/Jane Doe/app-server-control.sock");
});

// Bun's Windows WebSocket implementation does not honor ws's createConnection
// option, so these transport tests run on POSIX. The packaged Electron app uses
// the npm ws implementation; its native Windows socket path is supplied directly.
const describeSocketTransport = process.platform === "win32" ? describe.skip : describe;

describeSocketTransport("CodexClient against a scripted app-server", () => {
  test("connect + request/response round-trip over the UDS WebSocket", async () => {
    const { sock } = mockServer({
      "thread/loaded/list": (msg, send) =>
        send({ jsonrpc: "2.0", id: msg.id, result: { data: [THREAD] } }),
    });
    const client = await CodexClient.connect(sock);
    const res = (await client.request("thread/loaded/list", {})) as { data: string[] };
    expect(res.data).toEqual([THREAD]);
    client.close();
  });

  test("waitForTurnOutcome settles on OUR turn's completion, ignoring other turns", async () => {
    const { sock } = mockServer({
      "thread/resume": (msg, send) => send({ jsonrpc: "2.0", id: msg.id, result: idleThread }),
      "turn/start": (msg, send) => {
        send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-9" } } });
        // Noise: another turn completing must not settle our wait.
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId: THREAD, turn: { id: "other", status: "completed" } },
        });
        setTimeout(() => {
          send({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { threadId: THREAD, turn: { id: "turn-9", status: "completed" } },
          });
        }, 20);
      },
    });
    const client = await CodexClient.connect(sock);
    await client.request("thread/resume", { threadId: THREAD });
    const started = (await client.request("turn/start", {
      threadId: THREAD,
      input: [{ type: "text", text: "hi" }],
    })) as { turn: { id: string } };
    const outcome = await client.waitForTurnOutcome(THREAD, started.turn.id);
    expect(outcome).toEqual({ outcome: "completed" });
    client.close();
  });

  test("a failed turn reports outcome=failed with the error", async () => {
    const { sock } = mockServer({
      "turn/start": (msg, send) => {
        send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-2" } } });
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId: THREAD, turn: { id: "turn-2", status: "failed", error: "boom" } },
        });
      },
    });
    const client = await CodexClient.connect(sock);
    const started = (await client.request("turn/start", { threadId: THREAD, input: [] })) as {
      turn: { id: string };
    };
    const outcome = await client.waitForTurnOutcome(THREAD, started.turn.id);
    expect(outcome).toEqual({ outcome: "failed", error: "boom" });
    client.close();
  });

  test("server→client requests are answered via the injected answerer", async () => {
    const { sock, replies } = mockServer({
      "turn/start": (msg, send) => {
        send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-1" } } });
        send({
          jsonrpc: "2.0",
          id: 900,
          method: "mcpServer/elicitation/request",
          params: { threadId: THREAD, serverName: "robinhood" },
        });
      },
    });
    let seen: unknown = null;
    const client = await CodexClient.connect(sock, async (method, params) => {
      seen = { method, params };
      return { action: "decline" };
    });
    await client.request("turn/start", { threadId: THREAD, input: [] });
    await tick();
    expect(seen).toEqual({
      method: "mcpServer/elicitation/request",
      params: { threadId: THREAD, serverName: "robinhood" },
    });
    expect(replies).toEqual([{ jsonrpc: "2.0", id: 900, result: { action: "decline" } }]);
    client.close();
  });

  test("no answerer → the server request gets a JSON-RPC error (codex → decline)", async () => {
    const { sock, replies } = mockServer({
      "turn/start": (msg, send) => {
        send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "t" } } });
        send({
          jsonrpc: "2.0",
          id: 901,
          method: "mcpServer/elicitation/request",
          params: { threadId: THREAD },
        });
      },
    });
    const client = await CodexClient.connect(sock);
    await client.request("turn/start", { threadId: THREAD, input: [] });
    await tick();
    expect(replies).toHaveLength(1);
    expect((replies[0] as { id: number; error?: unknown }).id).toBe(901);
    expect((replies[0] as { error?: unknown }).error).toBeTruthy();
    client.close();
  });
});

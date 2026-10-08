import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { HostedEdge } from "./edge";

const SECRET = "s".repeat(48);
const TOKEN = "host-token";

let upstream: Server;
let wss: WebSocketServer;
let edge: HostedEdge;
let edgePort = 0;
const seen: Array<{ url: string; token: string | undefined }> = [];

beforeAll(async () => {
  // Stands in for both loopback servers: echoes what it received.
  upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? "", token: req.headers["x-opentrade-token"] as string });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: req.url }));
  });
  wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws, req) => ws.send(`hello ${req.url}`));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as AddressInfo).port;

  edge = new HostedEdge(() => ({ trpcPort: port, terminalPort: port, token: TOKEN }), SECRET);
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  edgePort = (probe.address() as AddressInfo).port;
  probe.close();
  await edge.listen(edgePort, "127.0.0.1");
});

afterAll(() => {
  edge.close();
  wss.close();
  upstream.close();
});

describe("hosted edge", () => {
  test("health is public; everything else needs the edge secret", async () => {
    expect((await fetch(`http://127.0.0.1:${edgePort}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${edgePort}/trpc/agents.list`)).status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${edgePort}/trpc/agents.list`, {
      headers: { "x-opentrade-edge": "x".repeat(48) },
    });
    expect(wrong.status).toBe(401);
  });

  test("tRPC HTTP: strips the /trpc prefix and injects the host token", async () => {
    const res = await fetch(`http://127.0.0.1:${edgePort}/trpc/agents.list?batch=1`, {
      headers: { "x-opentrade-edge": SECRET },
    });
    expect(await res.json()).toEqual({ url: "/agents.list?batch=1" });
    expect(seen.at(-1)?.token).toBe(TOKEN);
  });

  test("WebSocket upgrade: edge= query authenticates, token= is substituted", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${edgePort}/sessions/agent-1?replay=1&edge=${SECRET}`);
    const msg = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (e) => resolve(String(e.data));
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.close();
    expect(msg).toContain("/sessions/agent-1?");
    expect(msg).toContain(`token=${TOKEN}`);
    expect(msg).not.toContain(SECRET);
  });

  test("OAuth relay forwards a GET to the loopback port", async () => {
    const port = (upstream.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${edgePort}/oauth/relay/${port}/callback?code=abc`, {
      headers: { "x-opentrade-edge": SECRET },
    });
    expect(await res.json()).toEqual({ url: "/callback?code=abc" });
  });
});

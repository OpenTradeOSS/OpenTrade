import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";

/**
 * Hosted mode's single public port (OpenTrade Cloud). On the desktop the GUI talks to
 * the host's loopback servers directly; in a cloud sandbox the only thing that reaches
 * the host is the OpenTrade gateway, over the provider's private network. The edge:
 *
 *   /healthz            liveness for the sandbox orchestrator
 *   /trpc/*             tRPC over HTTP → the loopback tRPC server (prefix stripped)
 *   /trpc  (upgrade)    tRPC subscriptions over WebSocket → same server
 *   /sessions/* (upgr.) terminal data plane → the loopback terminal WS server
 *   /oauth/relay/<port>/<path>   an OAuth redirect for a loopback listener in the
 *                       sandbox (the broker consent, or an agent CLI's MCP login),
 *                       relayed from the browser through the gateway; GET only
 *
 * It authenticates the gateway with a per-sandbox secret (`x-opentrade-edge`, or
 * `edge=` on an upgrade URL, since browsers can't set WebSocket headers and the gateway
 * forwards their URL) and then injects the host token itself, so the token that guards
 * the loopback servers never leaves the machine. Upgrades are proxied at the TCP level:
 * the request head is replayed upstream and the two sockets are piped together.
 */
export interface EdgeTargets {
  trpcPort: number;
  terminalPort: number;
  token: string;
}

export const EDGE_SECRET_HEADER = "x-opentrade-edge";

export class HostedEdge {
  private server: Server | null = null;

  constructor(
    private targets: () => EdgeTargets,
    private secret: string,
  ) {}

  listen(port: number, host = "::"): Promise<void> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://edge");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      if (!this.authorized(req, url)) {
        res.writeHead(401);
        res.end();
        return;
      }
      const relay = url.pathname.match(/^\/oauth\/relay\/(\d{4,5})(\/.*)$/);
      if (relay && req.method === "GET") {
        relayLoopback(Number(relay[1]), relay[2] + url.search, res);
        return;
      }
      if (!url.pathname.startsWith("/trpc/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const t = this.targets();
      const headers: Record<string, string | string[] | undefined> = {
        ...req.headers,
        "x-opentrade-token": t.token,
      };
      delete headers[EDGE_SECRET_HEADER];
      const upstream = request(
        {
          host: "127.0.0.1",
          port: t.trpcPort,
          method: req.method,
          path: url.pathname.slice("/trpc".length) + url.search,
          headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });

    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://edge");
      if (!this.authorized(req, url)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      const t = this.targets();
      url.searchParams.delete("edge");
      url.searchParams.set("token", t.token);
      let port: number;
      let path: string;
      if (url.pathname === "/trpc" || url.pathname === "/trpc/") {
        port = t.trpcPort;
        path = `/${url.search}`;
      } else if (url.pathname.startsWith("/sessions/")) {
        port = t.terminalPort;
        path = url.pathname + url.search;
      } else {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      pipeUpgrade(req, socket, head, port, path);
    });

    this.server = server;
    return new Promise((resolve) => server.listen(port, host, () => resolve()));
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    const header = req.headers[EDGE_SECRET_HEADER];
    const provided = typeof header === "string" ? header : (url.searchParams.get("edge") ?? "");
    const a = Buffer.from(provided);
    const b = Buffer.from(this.secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  close(): void {
    this.server?.close();
  }
}

function relayLoopback(port: number, path: string, res: ServerResponse): void {
  if (port < 1024 || port > 65535) {
    res.writeHead(400);
    res.end();
    return;
  }
  const up = request({ host: "127.0.0.1", port, method: "GET", path }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("That sign-in link has expired. Start the connection again in OpenTrade.");
  });
  up.end();
}

function pipeUpgrade(
  req: IncomingMessage,
  client: Socket,
  head: Buffer,
  port: number,
  path: string,
): void {
  const upstream = connect(port, "127.0.0.1", () => {
    const lines = [`${req.method} ${path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (name.toLowerCase() === EDGE_SECRET_HEADER) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    client.destroy();
  };
  upstream.on("error", close);
  client.on("error", close);
  upstream.on("close", close);
  client.on("close", close);
}

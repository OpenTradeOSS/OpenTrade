import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";
import { Accounts, AuthError } from "./accounts";
import { loadConfig } from "./config";
import { Sealer, safeEqual } from "./crypto";
import { openDb, type SandboxRow, type UserRow } from "./db";
import { privacyPage, supportPage, termsPage } from "./legal";
import { LlmProxy } from "./llm";
import { accountPage, authPage, finishPage, startingPage } from "./pages";
import { CREDIT_PACKS, MICROS_PER_CREDIT, PLANS, planOf } from "./plans";
import { Push } from "./push";
import { Sandboxes } from "./sandboxes";
import { Billing } from "./stripe";

/**
 * OpenTrade Cloud gateway. Everything a browser or the iPhone app talks to:
 *
 *   /login /signup /account        the gateway's own pages
 *   /api/*                         auth, account, keys, billing, push registration
 *   /stripe/webhook                billing events
 *   /trpc/* and /sessions/* (ws)   the user's sandbox (OpenTrade host), proxied
 *   /llm/*                         metered model access for sandboxes
 *   /*                             the OpenTrade web app (renderer web build)
 */
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const sealer = new Sealer(cfg.masterKey);
const accounts = new Accounts(db);
const sandboxes = new Sandboxes(db, sealer, cfg);
const llm = new LlmProxy(db, accounts, sandboxes, sealer, cfg);
const push = new Push(db, cfg);
const billing = cfg.stripe.secretKey
  ? new Billing(cfg.stripe.secretKey, cfg.stripe.webhookSecret, db, accounts, cfg.publicUrl)
  : null;

const COOKIE = "ot_session";

// ── helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function sessionToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ots_")) return auth.slice(7);
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** True when the request authenticates with the cookie (a browser), not a bearer token. */
function usesCookie(req: Request): boolean {
  return !req.headers.get("authorization")?.startsWith("Bearer ots_");
}

function currentUser(req: Request): UserRow | null {
  return accounts.userForSession(sessionToken(req));
}

function sessionCookie(token: string, maxAgeSec: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${cfg.secureCookies ? "; Secure" : ""}`;
}

/**
 * Cookie-authenticated state changes must be same-origin JSON: a cross-site form can't
 * send `application/json` without a CORS preflight, which we never grant, and a
 * cross-site WebSocket is refused by Origin. Bearer-token clients (the app) are exempt.
 */
function sameOriginOk(req: Request): boolean {
  if (!usesCookie(req)) return true;
  const origin = req.headers.get("origin");
  if (origin && origin !== cfg.publicUrl) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  return (req.headers.get("content-type") ?? "").includes("application/json");
}

const attempts = new Map<string, { n: number; reset: number }>();
function rateLimited(key: string, max = 10, windowMs = 15 * 60_000): boolean {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) {
    attempts.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  a.n++;
  return a.n > max;
}

function mask(sealed: string | null): string | null {
  if (!sealed) return null;
  const k = sealer.open(sealed);
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}

async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

// ── static web app ───────────────────────────────────────────────────────────

const webRoot = normalize(cfg.webDir);
function staticFile(pathname: string): Response | null {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(webRoot, rel);
  if (!file.startsWith(webRoot) || !existsSync(file) || file.endsWith("/")) return null;
  const f = Bun.file(file);
  const immutable = rel.startsWith("/assets/");
  return new Response(f, {
    headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
  });
}

// ── sandbox proxy ────────────────────────────────────────────────────────────

function runningSandbox(user: UserRow) {
  const row = sandboxes.get(user.id);
  return row?.status === "running" && row.address ? row : null;
}

function trpcError(status: number, code: string, message: string, batch: boolean): Response {
  const err = { error: { json: { message, code: -32600, data: { code, httpStatus: status } } } };
  return json(batch ? [err] : err, status);
}

async function agentCount(address: string, secret: string): Promise<number> {
  const res = await fetch(`${address}/trpc/agents.list`, {
    headers: { "x-opentrade-edge": secret },
  });
  const body = (await res.json()) as { result?: { data?: { json?: unknown[] } } };
  return body.result?.data?.json?.length ?? 0;
}

async function proxyTrpc(req: Request, user: UserRow, url: URL): Promise<Response> {
  const row = runningSandbox(user);
  if (!row)
    return trpcError(
      503,
      "SERVICE_UNAVAILABLE",
      "Your workspace is starting.",
      url.searchParams.has("batch"),
    );
  const secret = sandboxes.edgeSecret(row);
  const procedures = url.pathname.slice("/trpc/".length).split(",");

  // Plan limit: agents.create past the plan's agent cap is refused here, before the host.
  if (procedures.includes("agents.create")) {
    const plan = planOf(user.plan);
    if ((await agentCount(row.address as string, secret)) >= plan.maxAgents) {
      return trpcError(
        403,
        "FORBIDDEN",
        `Your ${plan.name} plan includes ${plan.maxAgents} agents. Upgrade in Account to add more.`,
        url.searchParams.has("batch"),
      );
    }
  }

  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (!["cookie", "authorization", "host", "content-length", "origin", "referer"].includes(k))
      headers.set(k, v);
  }
  headers.set("x-opentrade-edge", secret);
  try {
    const res = await fetch(`${row.address}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" ? undefined : await req.arrayBuffer(),
    });
    const out = new Headers(res.headers);
    out.delete("access-control-allow-origin");
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(res.body, { status: res.status, headers: out });
  } catch {
    return trpcError(
      502,
      "BAD_GATEWAY",
      "Couldn't reach your workspace.",
      url.searchParams.has("batch"),
    );
  }
}

interface WsData {
  target: string;
  upstream?: WebSocket;
  queue: Array<string | Uint8Array>;
}

const websocket = {
  open(ws: ServerWebSocket<WsData>) {
    const up = new WebSocket(ws.data.target);
    up.binaryType = "arraybuffer";
    ws.data.upstream = up;
    up.onopen = () => {
      for (const m of ws.data.queue) up.send(m);
      ws.data.queue = [];
    };
    up.onmessage = (ev) => {
      ws.send(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
    };
    up.onclose = (ev) => ws.close(ev.code === 1005 || ev.code === 1006 ? 1011 : ev.code, ev.reason);
    up.onerror = () => ws.close(1011, "upstream error");
  },
  message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
    const up = ws.data.upstream;
    const data = typeof msg === "string" ? msg : new Uint8Array(msg);
    if (up && up.readyState === WebSocket.OPEN) up.send(data);
    else ws.data.queue.push(data);
  },
  close(ws: ServerWebSocket<WsData>) {
    ws.data.upstream?.close();
  },
};

async function relayOAuth(row: SandboxRow, pathAndQuery: string): Promise<Response> {
  const res = await fetch(`${row.address}${pathAndQuery}`, {
    headers: { "x-opentrade-edge": sandboxes.edgeSecret(row) },
    redirect: "manual",
  });
  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  return new Response(res.body, { status: res.status, headers: out });
}

/**
 * An agent CLI's own MCP login (e.g. Robinhood in Claude Code) redirects the browser to
 * http://localhost:<port>/… on the user's computer, where nothing listens. The user
 * pastes that URL here and we deliver it to the same port inside their sandbox.
 */
function loopbackPathFrom(pasted: string): string | null {
  try {
    const u = new URL(pasted.trim());
    if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || !u.port) return null;
    return `/oauth/relay/${u.port}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

// ── sandbox events → push ────────────────────────────────────────────────────

async function sandboxEvent(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization");
  const userId = auth?.startsWith("Bearer ") ? sandboxes.userForKey(auth.slice(7)) : null;
  if (!userId) return json({ error: "unauthorized" }, 401);
  const ev = await readJson(req);
  if (ev.type === "approval.pending") {
    const cost = typeof ev.estCost === "number" ? ` (~$${ev.estCost.toFixed(2)})` : "";
    await push.send(userId, {
      title: `${ev.agentName ?? "An agent"} wants to place an order`,
      body: `${String(ev.summary ?? "Order").slice(0, 160)}${cost}. Tap to review.`,
      data: { type: "approval", approvalId: String(ev.approvalId), agentId: String(ev.agentId) },
      category: "approval",
    });
  }
  return json({ ok: true });
}

// ── /api ─────────────────────────────────────────────────────────────────────

async function me(user: UserRow): Promise<Record<string, unknown>> {
  const sandbox = sandboxes.get(user.id);
  const since = Date.now() - 30 * 86_400_000;
  const rows = db
    .query<
      { agent_id: string | null; model: string; tokens: number; cost: number; byok: number },
      [string, number]
    >(
      `SELECT agent_id, model, SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
              SUM(cost_micros) AS cost, MAX(byok) AS byok
       FROM usage WHERE user_id = ? AND at > ? GROUP BY agent_id, model ORDER BY cost DESC LIMIT 50`,
    )
    .all(user.id, since);
  let names = new Map<string, string>();
  if (sandbox?.status === "running" && sandbox.address && rows.some((r) => r.agent_id)) {
    try {
      const res = await fetch(`${sandbox.address}/trpc/agents.list`, {
        headers: { "x-opentrade-edge": sandboxes.edgeSecret(sandbox) },
        signal: AbortSignal.timeout(3000),
      });
      const body = (await res.json()) as {
        result?: { data?: { json?: Array<{ id: string; name: string }> } };
      };
      names = new Map((body.result?.data?.json ?? []).map((a) => [a.id, a.name]));
    } catch {}
  }
  return {
    user: {
      id: user.id,
      email: user.email,
      plan: user.plan,
      planRenewsAt: user.plan_renews_at,
      hasSubscription: Boolean(user.stripe_subscription_id),
      byok: { anthropic: mask(user.byok_anthropic), openai: mask(user.byok_openai) },
    },
    credits: accounts.balanceMicros(user.id) / MICROS_PER_CREDIT,
    limits: { maxAgents: planOf(user.plan).maxAgents },
    sandbox: sandbox ? { status: sandbox.status, error: sandbox.error } : null,
    plans: Object.values(PLANS).map(({ lookupKey, ...p }) => p),
    packs: CREDIT_PACKS.map(({ lookupKey, ...p }) => p),
    billingEnabled: Boolean(billing),
    usage: rows.map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_id ? (names.get(r.agent_id) ?? null) : null,
      model: r.model,
      tokens: r.tokens,
      credits: r.cost / MICROS_PER_CREDIT,
      byok: Boolean(r.byok),
    })),
    vapidPublicKey: cfg.push.vapidPublic,
  };
}

async function validateKey(provider: "anthropic" | "openai", key: string): Promise<boolean> {
  const res =
    provider === "anthropic"
      ? await fetch("https://api.anthropic.com/v1/models?limit=1", {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        })
      : await fetch("https://api.openai.com/v1/models", {
          headers: { authorization: `Bearer ${key}` },
        });
  return res.ok;
}

async function api(req: Request, url: URL, ip: string): Promise<Response> {
  const path = url.pathname;
  if (!sameOriginOk(req)) return json({ error: "Cross-origin request refused." }, 403);

  if (path === "/api/auth/signup" || path === "/api/auth/login") {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const body = await readJson(req);
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");
    if (rateLimited(`auth:${ip}`, 20) || rateLimited(`auth:${email.toLowerCase()}`, 10)) {
      return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    }
    try {
      const user = path.endsWith("signup")
        ? await accounts.signup(email, password)
        : await accounts.login(email, password);
      sandboxes.ensure(user.id);
      const mobile = body.client === "mobile";
      const token = accounts.createSession(user.id, mobile ? "mobile" : "web");
      if (mobile) return json({ token });
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, 30 * 86_400) });
    } catch (err) {
      if (err instanceof AuthError) return json({ error: err.message }, 400);
      throw err;
    }
  }

  if (path === "/api/sandbox/events" && req.method === "POST") return sandboxEvent(req);
  if (path === "/api/health") return json({ ok: true });

  const user = currentUser(req);
  if (!user) return json({ error: "Not signed in." }, 401);

  if (path === "/api/auth/logout" && req.method === "POST") {
    const t = sessionToken(req);
    if (t) accounts.endSession(t);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }
  if (path === "/api/me" && req.method === "GET") {
    sandboxes.ensure(user.id);
    return json(await me(user));
  }
  if (path === "/api/oauth/finish" && req.method === "POST") {
    const body = await readJson(req);
    const relayPath = loopbackPathFrom(String(body.url ?? ""));
    if (!relayPath)
      return json(
        {
          error: "Paste the full address your browser ended on (it starts with http://localhost).",
        },
        400,
      );
    const row = runningSandbox(user);
    if (!row) return json({ error: "Your workspace isn't running." }, 503);
    const res = await relayOAuth(row, relayPath);
    return res.ok
      ? json({ ok: true })
      : json({ error: "That sign-in link has expired. Start the login again." }, 400);
  }
  if (path === "/api/sandbox/retry" && req.method === "POST") {
    sandboxes.retry(user.id);
    return json({ ok: true });
  }
  if (path === "/api/keys" && req.method === "POST") {
    const body = await readJson(req);
    const provider =
      body.provider === "openai" ? "openai" : body.provider === "anthropic" ? "anthropic" : null;
    if (!provider) return json({ error: "Unknown provider." }, 400);
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const column = provider === "anthropic" ? "byok_anthropic" : "byok_openai";
    if (!key) {
      accounts.update(user.id, { [column]: null });
      return json({ ok: true });
    }
    if (rateLimited(`keys:${user.id}`, 20)) return json({ error: "Too many attempts." }, 429);
    if (!(await validateKey(provider, key).catch(() => false))) {
      return json(
        {
          error: `That ${provider === "anthropic" ? "Anthropic" : "OpenAI"} key didn't work. Check it and try again.`,
        },
        400,
      );
    }
    accounts.update(user.id, { [column]: sealer.seal(key) });
    return json({ ok: true });
  }
  if (path === "/api/billing/checkout" && req.method === "POST") {
    if (!billing) return json({ error: "Billing isn't set up yet." }, 503);
    const body = await readJson(req);
    try {
      return json({ url: await billing.checkout(user, String(body.item)) });
    } catch (err) {
      console.error("checkout failed", err);
      return json({ error: "Couldn't start checkout. Try again shortly." }, 502);
    }
  }
  if (path === "/api/billing/portal" && req.method === "POST") {
    if (!billing) return json({ error: "Billing isn't set up yet." }, 503);
    return json({ url: await billing.portal(user) });
  }
  if (path === "/api/push/register" && req.method === "POST") {
    const body = await readJson(req);
    const kind = body.kind === "web" ? "web" : body.kind === "expo" ? "expo" : null;
    const target =
      typeof body.target === "string" ? body.target : JSON.stringify(body.target ?? "");
    if (!kind || target.length < 10 || target.length > 4000)
      return json({ error: "Bad push target." }, 400);
    push.register(user.id, kind, target);
    return json({ ok: true });
  }
  if (path === "/api/push/unregister" && req.method === "POST") {
    const body = await readJson(req);
    const target =
      typeof body.target === "string" ? body.target : JSON.stringify(body.target ?? "");
    push.unregister(body.kind === "web" ? "web" : "expo", target);
    return json({ ok: true });
  }
  if (path === "/api/push/test" && req.method === "POST") {
    const sent = await push.send(user.id, {
      title: "OpenTrade",
      body: "Notifications are on. Orders that need you will show up here.",
    });
    return json({ sent });
  }
  if (path === "/api/account" && req.method === "DELETE") {
    if (billing) await billing.cancelSubscription(user);
    await sandboxes.destroy(user.id);
    accounts.delete(user.id);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }
  return json({ error: "Not found." }, 404);
}

// ── server ───────────────────────────────────────────────────────────────────

const server = Bun.serve<WsData, never>({
  port: cfg.port,
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = req.headers.get("fly-client-ip") ?? srv.requestIP(req)?.address ?? "unknown";

    try {
      if (path.startsWith("/llm/anthropic/"))
        return await llm.handle(req, "anthropic", path.slice("/llm/anthropic".length));
      if (path.startsWith("/llm/openai/"))
        return await llm.handle(req, "openai", path.slice("/llm/openai".length));
      if (path === "/stripe/webhook" && req.method === "POST") {
        if (!billing) return new Response("billing disabled", { status: 503 });
        const r = await billing.webhook(await req.text(), req.headers.get("stripe-signature"));
        return new Response(r.body, { status: r.status });
      }
      if (path === "/admin/upgrade-sandboxes" && req.method === "POST") {
        const auth = req.headers.get("authorization") ?? "";
        if (!cfg.adminToken || !safeEqual(auth, `Bearer ${cfg.adminToken}`)) {
          return json({ error: "unauthorized" }, 401);
        }
        const ids = db
          .query<{ user_id: string }, []>("SELECT user_id FROM sandboxes WHERE status = 'running'")
          .all()
          .map((r) => r.user_id);
        const results: Record<string, string> = {};
        for (const id of ids) {
          results[id] = await sandboxes.upgrade(id).then(
            () => "ok",
            (err) => String(err).slice(0, 200),
          );
        }
        return json({ upgraded: results });
      }
      if (path.startsWith("/api/")) return await api(req, url, ip);

      const legal = { "/privacy": privacyPage, "/terms": termsPage, "/support": supportPage }[path];
      if (legal)
        return new Response(legal(), { headers: { "content-type": "text/html; charset=utf-8" } });

      if (path === "/login" || path === "/signup") {
        if (currentUser(req)) return Response.redirect(`${cfg.publicUrl}/`, 302);
        return new Response(authPage(path === "/login" ? "login" : "signup"), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // OAuth redirects for loopback listeners inside the user's sandbox (top-level GET
      // navigation, so the Lax session cookie is sent).
      if (path.startsWith("/oauth/relay/") && req.method === "GET") {
        const user = currentUser(req);
        const row = user ? runningSandbox(user) : null;
        if (!row) return Response.redirect(`${cfg.publicUrl}/login`, 302);
        return await relayOAuth(row, `${path}${url.search}`);
      }
      if (path === "/oauth/finish") {
        const user = currentUser(req);
        if (!user) return Response.redirect(`${cfg.publicUrl}/login`, 302);
        return new Response(finishPage(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // The user's sandbox: tRPC over HTTP, and WebSockets for subscriptions + terminals.
      const isWs = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (path.startsWith("/trpc") || path.startsWith("/sessions/")) {
        const user = currentUser(req);
        if (!user)
          return isWs
            ? new Response("unauthorized", { status: 401 })
            : trpcError(401, "UNAUTHORIZED", "Not signed in.", url.searchParams.has("batch"));
        if (!sameOriginOk(req)) return new Response("forbidden", { status: 403 });
        if (isWs) {
          const row = runningSandbox(user);
          if (!row) return new Response("workspace starting", { status: 503 });
          const target = new URL(
            `${(row.address as string).replace(/^http/, "ws")}${path}${url.search}`,
          );
          target.searchParams.set("edge", sandboxes.edgeSecret(row));
          if (srv.upgrade(req, { data: { target: target.toString(), queue: [] } }))
            return undefined as unknown as Response;
          return new Response("upgrade failed", { status: 400 });
        }
        if (path.startsWith("/trpc/")) return await proxyTrpc(req, user, url);
        return new Response("not found", { status: 404 });
      }

      // Public assets (icons, manifest, service worker, hashed bundles).
      if (path !== "/" && path !== "/index.html") {
        const file = staticFile(path);
        if (file) return file;
      }

      const user = currentUser(req);
      if (!user) return Response.redirect(`${cfg.publicUrl}/login`, 302);
      if (path === "/account")
        return new Response(accountPage(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });

      sandboxes.ensure(user.id);
      const sandbox = sandboxes.get(user.id);
      if (sandbox?.status !== "running") {
        return new Response(
          startingPage(sandbox?.status === "error" ? (sandbox.error ?? "Unknown error") : null),
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
      const index = staticFile("/index.html");
      return index ?? new Response("web app not built", { status: 500 });
    } catch (err) {
      console.error("request failed", req.method, path, err);
      return json({ error: "Internal error." }, 500);
    }
  },
  websocket,
});

console.log(
  `gateway listening on :${server.port} (${cfg.publicUrl}, sandboxes via ${cfg.sandbox.driver})`,
);

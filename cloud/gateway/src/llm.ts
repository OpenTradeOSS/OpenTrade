import type { Accounts } from "./accounts";
import type { Config } from "./config";
import type { Sealer } from "./crypto";
import type { Db } from "./db";
import { listCostMicros, type TokenUsage } from "./plans";
import type { Sandboxes } from "./sandboxes";

/**
 * Metering proxy between a sandbox's agent CLIs and the model providers. The sandbox
 * holds only its own gateway key (as ANTHROPIC_API_KEY / OPENAI_API_KEY, with the base
 * URLs pointed here); the gateway swaps in the platform key — or the user's own key
 * (BYOK) — and records the usage each response reports, debiting credits unless BYOK.
 *
 *   /llm/anthropic/*      → https://api.anthropic.com/*
 *   /llm/openai/v1/*      → https://api.openai.com/v1/*
 *
 * Responses stream through untouched; usage is read from the stream as it passes.
 */
type Provider = "anthropic" | "openai";

const UPSTREAM: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  "x-api-key",
  "authorization",
  "x-opentrade-agent",
  "proxy-authorization",
]);

export class LlmProxy {
  constructor(
    private db: Db,
    private accounts: Accounts,
    private sandboxes: Sandboxes,
    private sealer: Sealer,
    private cfg: Config,
  ) {}

  async handle(req: Request, provider: Provider, upstreamPath: string): Promise<Response> {
    const sandboxKey =
      provider === "anthropic" ? (req.headers.get("x-api-key") ?? bearer(req)) : bearer(req);
    const userId = sandboxKey ? this.sandboxes.userForKey(sandboxKey) : null;
    if (!userId)
      return providerError(provider, 401, "authentication_error", "Unknown sandbox key.");
    const user = this.accounts.byId(userId);
    if (!user) return providerError(provider, 401, "authentication_error", "Account not found.");

    const byokSealed = provider === "anthropic" ? user.byok_anthropic : user.byok_openai;
    const byok = byokSealed ? this.sealer.open(byokSealed) : null;
    const platformKey =
      provider === "anthropic" ? this.cfg.providers.anthropicKey : this.cfg.providers.openaiKey;
    const key = byok ?? platformKey;
    if (!key) {
      return providerError(
        provider,
        400,
        "invalid_request_error",
        `No ${provider === "anthropic" ? "Anthropic" : "OpenAI"} key: add your own key in OpenTrade → Account.`,
      );
    }
    if (!byok && this.accounts.balanceMicros(userId) <= 0) {
      return providerError(
        provider,
        400,
        "billing_error",
        "Out of OpenTrade credits. Your agents are paused until you top up or add your own API key in OpenTrade → Account.",
      );
    }

    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
    });
    headers.set("accept-encoding", "identity");
    if (provider === "anthropic") headers.set("x-api-key", key);
    else headers.set("authorization", `Bearer ${key}`);
    const agentId = req.headers.get("x-opentrade-agent");

    const url = new URL(req.url);
    const upstream = await fetch(`${UPSTREAM[provider]}${upstreamPath}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    });

    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    if (!upstream.body || !upstream.ok) {
      return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
    }

    const record = (model: string, u: TokenUsage) =>
      this.record(userId, provider, model, agentId, u, byok !== null);
    const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    const meter = isSse ? sseMeter(provider, record) : jsonMeter(provider, record);
    return new Response(upstream.body.pipeThrough(meter), {
      status: upstream.status,
      headers: outHeaders,
    });
  }

  record(
    userId: string,
    provider: Provider,
    model: string,
    agentId: string | null,
    u: TokenUsage,
    byok: boolean,
  ): void {
    if (!u.input && !u.output && !u.cacheRead && !u.cacheWrite) return;
    const list = listCostMicros(provider, model, u);
    const billed = Math.ceil(list * this.cfg.creditMargin);
    this.db.run(
      `INSERT INTO usage (user_id, provider, model, agent_id, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cost_micros, byok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        provider,
        model,
        agentId,
        u.input,
        u.output,
        u.cacheRead,
        u.cacheWrite,
        billed,
        byok ? 1 : 0,
        Date.now(),
      ],
    );
    if (!byok) this.accounts.credit(userId, -billed, `usage:${provider}:${model}`);
  }
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

function providerError(
  provider: Provider,
  status: number,
  type: string,
  message: string,
): Response {
  const body =
    provider === "anthropic"
      ? { type: "error", error: { type, message } }
      : { error: { type, message, code: type } };
  return Response.json(body, { status });
}

type Recorder = (model: string, u: TokenUsage) => void;

const empty = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Usage from a provider's JSON usage object (Anthropic Messages, OpenAI Responses/Chat). */
export function usageFrom(
  provider: Provider,
  usage: Record<string, unknown> | undefined,
): TokenUsage {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (!usage) return empty();
  if (provider === "anthropic") {
    return {
      input: n(usage.input_tokens),
      output: n(usage.output_tokens),
      cacheRead: n(usage.cache_read_input_tokens),
      cacheWrite: n(usage.cache_creation_input_tokens),
    };
  }
  const details = (usage.input_tokens_details ?? usage.prompt_tokens_details) as
    | Record<string, unknown>
    | undefined;
  const cached = n(details?.cached_tokens);
  const input = n(usage.input_tokens ?? usage.prompt_tokens);
  return {
    input: Math.max(0, input - cached),
    output: n(usage.output_tokens ?? usage.completion_tokens),
    cacheRead: cached,
    cacheWrite: 0,
  };
}

/** Pass bytes through; at the end, parse the whole JSON body for `usage`. */
function jsonMeter(provider: Provider, record: Recorder): TransformStream<Uint8Array, Uint8Array> {
  const chunks: Uint8Array[] = [];
  return new TransformStream({
    transform(chunk, ctl) {
      chunks.push(chunk);
      ctl.enqueue(chunk);
    },
    flush() {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const usage = body.usage ?? body.response?.usage;
        if (usage)
          record(
            String(body.model ?? body.response?.model ?? "unknown"),
            usageFrom(provider, usage),
          );
      } catch {}
    },
  });
}

/**
 * Pass an SSE stream through, reading usage events as they go by:
 *   Anthropic: message_start (input + cache, model) and message_delta (cumulative output)
 *   OpenAI:    response.completed (Responses API) or a final chunk with `usage` (Chat)
 */
export function sseMeter(
  provider: Provider,
  record: Recorder,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buf = "";
  let model = "unknown";
  let usage = empty();
  let seen = false;

  const onEvent = (data: string) => {
    if (!data || data === "[DONE]") return;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (provider === "anthropic") {
      if (ev.type === "message_start" && ev.message) {
        model = ev.message.model ?? model;
        const u = usageFrom("anthropic", ev.message.usage);
        usage = { ...u };
        seen = true;
      } else if (ev.type === "message_delta" && ev.usage) {
        const u = usageFrom("anthropic", ev.usage);
        usage.output = u.output || usage.output;
        // Some responses report final input/cache counts on the delta too.
        if (u.input) usage.input = u.input;
        if (u.cacheRead) usage.cacheRead = u.cacheRead;
        if (u.cacheWrite) usage.cacheWrite = u.cacheWrite;
        seen = true;
      }
      return;
    }
    if (ev.type === "response.completed" && ev.response?.usage) {
      model = ev.response.model ?? model;
      usage = usageFrom("openai", ev.response.usage);
      seen = true;
    } else if (ev.usage && (ev.object === "chat.completion.chunk" || ev.choices)) {
      model = ev.model ?? model;
      usage = usageFrom("openai", ev.usage);
      seen = true;
    }
  };

  const drain = (final: boolean) => {
    let idx = buf.indexOf("\n\n");
    while (idx !== -1 || (final && buf.length)) {
      const block = idx === -1 ? buf : buf.slice(0, idx);
      buf = idx === -1 ? "" : buf.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      onEvent(data);
      idx = buf.indexOf("\n\n");
    }
  };

  return new TransformStream({
    transform(chunk, ctl) {
      ctl.enqueue(chunk);
      buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      drain(false);
    },
    flush() {
      buf += decoder.decode();
      drain(true);
      if (seen) record(model, usage);
    },
  });
}

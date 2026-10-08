import * as SecureStore from "expo-secure-store";

/**
 * Client for the OpenTrade Cloud gateway. Auth is a bearer session token from
 * `/api/auth/login` (client: "mobile"), kept in the iOS keychain. The user's OpenTrade
 * host is reached through the gateway's `/trpc` proxy with the same token.
 */
export const GATEWAY_URL = (process.env.EXPO_PUBLIC_GATEWAY_URL ?? "https://opentrade-gateway.fly.dev").replace(/\/$/, "");

const TOKEN_KEY = "opentrade.session";
let token: string | null = null;

export async function loadToken(): Promise<string | null> {
  token = await SecureStore.getItemAsync(TOKEN_KEY);
  return token;
}

async function saveToken(t: string | null): Promise<void> {
  token = t;
  if (t) await SecureStore.setItemAsync(TOKEN_KEY, t);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Fired when the session is rejected, so the app can return to sign-in. */
let onSignedOut: (() => void) | null = null;
export function setSignedOutHandler(fn: () => void): void {
  onSignedOut = fn;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${GATEWAY_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (res.status === 401 && token) {
    await saveToken(null);
    onSignedOut?.();
  }
  if (!res.ok) {
    const message = body.error?.json?.message ?? body.error ?? "Something went wrong. Try again.";
    throw new ApiError(typeof message === "string" ? message : "Something went wrong.", res.status);
  }
  return body;
}

export async function signIn(mode: "login" | "signup", email: string, password: string): Promise<void> {
  const body = (await request(`/api/auth/${mode}`, {
    method: "POST",
    body: JSON.stringify({ email, password, client: "mobile" }),
  })) as { token: string };
  await saveToken(body.token);
}

export async function signOut(): Promise<void> {
  await request("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
  await saveToken(null);
}

export async function deleteAccount(): Promise<void> {
  await request("/api/account", { method: "DELETE", body: "{}" });
  await saveToken(null);
}

export interface Me {
  user: { id: string; email: string; plan: string; hasSubscription: boolean };
  credits: number;
  limits: { maxAgents: number };
  sandbox: { status: "creating" | "running" | "error" | "deleting"; error: string | null } | null;
  plans: Array<{ id: string; name: string; priceUsd: number; monthlyCredits: number; maxAgents: number }>;
  usage: Array<{ agentId: string | null; agentName: string | null; model: string; tokens: number; credits: number; byok: boolean }>;
}

export function me(): Promise<Me> {
  return request("/api/me") as Promise<Me>;
}

export async function registerPush(expoToken: string): Promise<void> {
  await request("/api/push/register", { method: "POST", body: JSON.stringify({ kind: "expo", target: expoToken }) });
}

// ── the user's OpenTrade host, through the gateway's tRPC proxy ─────────────────

/** tRPC over HTTP with the superjson transformer (plain JSON values: no Dates/Maps here). */
export async function query<T>(procedure: string, input?: unknown): Promise<T> {
  const q = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const body = (await request(`/trpc/${procedure}${q}`)) as { result: { data: { json: T } } };
  return body.result.data.json;
}

export async function mutate<T>(procedure: string, input: unknown): Promise<T> {
  const body = (await request(`/trpc/${procedure}`, {
    method: "POST",
    body: JSON.stringify({ json: input }),
  })) as { result: { data: { json: T } } };
  return body.result.data.json;
}

// Shapes mirrored from app/src/shared (kept minimal; the host is the source of truth).

export interface ParsedOrder {
  kind: "place" | "cancel" | "exercise" | "unknown";
  symbol: string | null;
  side: string | null;
  quantity: number | null;
  orderType: string | null;
  limitPrice: number | null;
  estCost: number | null;
  summary: string;
}

export interface Approval {
  id: string;
  agentId: string;
  agentName: string | null;
  toolName: string;
  parsed: ParsedOrder | null;
  status: "pending" | "approved" | "rejected" | "expired";
  timeoutSec: number;
  requestedAt: number;
}

export interface Agent {
  id: string;
  name: string;
  harness: "claude" | "codex";
  status: string;
  executionState: string;
  approvalMode: "approve" | "auto";
}

export interface AuditEntry {
  id: number;
  agentId: string | null;
  agentName: string | null;
  kind: string;
  payload: unknown;
  at: number;
}

export interface Portfolio {
  equity: number | null;
  buyingPower: number | null;
  cash: number | null;
  dayChange: number | null;
  dayChangePct: number | null;
}

export interface Position {
  symbol: string;
  quantity: number;
  lastPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
}

import type { AppRouter } from "@main/trpc/routers";
import { createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";
import { useConnectionStore } from "../stores/connection";
import { resolveWsUrl } from "./terminal/ws-transport";

export const trpc = createTRPCReact<AppRouter>();

declare global {
  interface Window {
    /** Backend endpoint injected by the preload (see preload/index.ts). */
    __opentradeHost?: { trpcPort: number; token: string };
  }
}

let created = false;

/**
 * Whether the launcher handed us a real backend port. Set once when the tRPC client
 * is built (below, at module load), so it's ready before the first App render. False
 * means the host failed to start → the App shows the BackendFailed screen.
 */
export let backendStarted = false;

function createTrpcClient() {
  if (created) throw new Error("second tRPC client created — see trpcClient comment");
  created = true;

  const host = window.__opentradeHost ?? { trpcPort: 0, token: "" };
  // No preload bridge at all = the web app (OpenTrade Cloud): the backend is the user's
  // sandbox, reached same-origin through the gateway, which authenticates the session
  // cookie — so no token. On the desktop the bridge always exists, and trpcPort===0
  // means the launcher couldn't spawn/adopt the backend host (see main/index.ts); the
  // App reads this to show the "backend failed to start" screen.
  const web = !window.__opentradeHost;
  backendStarted = web || host.trpcPort > 0;
  const httpUrl = web ? `${window.location.origin}/trpc` : `http://127.0.0.1:${host.trpcPort}`;
  const wsUrl = web
    ? resolveWsUrl("/trpc")
    : `ws://127.0.0.1:${host.trpcPort}?token=${encodeURIComponent(host.token)}`;
  // wsLink auto-reconnects, so subscriptions recover when the backend restarts.
  // onOpen/onClose drive the sidebar "connecting" indicator (host can be briefly down).
  const setConnected = (v: boolean) => useConnectionStore.getState().setConnected(v);
  const wsClient = createWSClient({
    url: wsUrl,
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
    onError: () => setConnected(false),
  });

  return trpc.createClient({
    links: [
      // Subscriptions ride the WebSocket; queries/mutations batch over HTTP.
      splitLink({
        condition: (op) => op.type === "subscription",
        true: wsLink({ client: wsClient, transformer: superjson }),
        false: httpBatchLink({
          url: httpUrl,
          transformer: superjson,
          headers: (): Record<string, string> => (web ? {} : { "x-opentrade-token": host.token }),
        }),
      }),
    ],
  });
}

/**
 * The single app-wide tRPC client, shared between React hooks (via the Provider
 * in main.tsx) and imperative callers (the terminal registry). It MUST be one
 * client: a module-level singleton is the only construction that survives React
 * StrictMode, which double-invokes useState initializers in dev and discards one
 * result — creating the client in a component made hooks and the registry hold
 * DIFFERENT clients (and DIFFERENT WebSocket connections).
 */
export const trpcClient = createTrpcClient();

export function getImperativeClient(): typeof trpcClient {
  return trpcClient;
}

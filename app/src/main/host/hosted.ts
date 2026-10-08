/**
 * OpenTrade Cloud: the same host, run in a per-user sandbox behind the OpenTrade
 * gateway instead of next to a desktop GUI. Switched on by the sandbox image
 * (`OPENTRADE_HOSTED=1`); everything here is read once at startup.
 *
 *   OPENTRADE_EDGE_PORT     public port of the edge (default 8080)
 *   OPENTRADE_EDGE_SECRET   per-sandbox secret the gateway presents (required)
 *   OPENTRADE_GATEWAY_URL   the gateway, for push-worthy events (optional)
 *   OPENTRADE_SANDBOX_KEY   this sandbox's key at the gateway (with the URL above)
 *
 * Model access is the gateway's job: the sandbox gets `ANTHROPIC_BASE_URL` /
 * `OPENAI_BASE_URL` pointed at the gateway's metering proxy and a per-sandbox key, so
 * neither the platform's provider keys nor a user's own key ever live in the sandbox.
 */
export const IS_HOSTED = process.env.OPENTRADE_HOSTED === "1";

export interface HostedConfig {
  edgePort: number;
  edgeSecret: string;
  gatewayUrl: string | null;
  sandboxKey: string | null;
}

export function hostedConfig(): HostedConfig {
  const edgeSecret = process.env.OPENTRADE_EDGE_SECRET ?? "";
  if (edgeSecret.length < 32) {
    throw new Error("OPENTRADE_EDGE_SECRET must be set (32+ chars) in hosted mode");
  }
  return {
    edgePort: Number(process.env.OPENTRADE_EDGE_PORT) || 8080,
    edgeSecret,
    gatewayUrl: process.env.OPENTRADE_GATEWAY_URL || null,
    sandboxKey: process.env.OPENTRADE_SANDBOX_KEY || null,
  };
}

/** Env the sandbox needs for itself but agents must never inherit. */
export const HOSTED_PRIVATE_ENV = ["OPENTRADE_EDGE_SECRET"] as const;

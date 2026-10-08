/**
 * Gateway configuration, read once from the environment. Secrets (provider keys, the
 * Stripe key, the master key) come only from the environment — on Fly, `fly secrets`.
 */
function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required env ${name}`);
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v ? v : null;
}

export interface Config {
  /** Public origin of the gateway, e.g. https://app.opentrade.bot (no trailing slash). */
  publicUrl: string;
  port: number;
  dbPath: string;
  /** Static web app (the renderer built with `bun run build:web`). */
  webDir: string;
  /** 32-byte hex key that encrypts per-user secrets at rest (BYOK keys, edge secrets). */
  masterKey: string;
  sandbox: {
    driver: "docker" | "fly";
    image: string;
    flyApp: string;
    flyToken: string | null;
    flyRegion: string;
    /** Origin a sandbox uses to reach the gateway (LLM proxy, events). */
    gatewayUrlForSandbox: string;
  };
  providers: { anthropicKey: string | null; openaiKey: string | null };
  stripe: { secretKey: string | null; webhookSecret: string | null };
  push: { vapidPublic: string | null; vapidPrivate: string | null; vapidSubject: string };
  /** Mark-up applied to provider list prices when debiting credits. */
  creditMargin: number;
  secureCookies: boolean;
  /** Accounts whose sandbox runs the demo approval loop (App Review). */
  demoEmails: string[];
  /** Bearer token for /admin endpoints (unset = admin disabled). */
  adminToken: string | null;
}

export function loadConfig(): Config {
  const publicUrl = env("GATEWAY_PUBLIC_URL", "http://localhost:8787").replace(/\/$/, "");
  const driver = env("SANDBOX_DRIVER", "docker");
  if (driver !== "docker" && driver !== "fly") throw new Error(`bad SANDBOX_DRIVER ${driver}`);
  const masterKey = env("GATEWAY_MASTER_KEY");
  if (!/^[0-9a-f]{64}$/i.test(masterKey))
    throw new Error("GATEWAY_MASTER_KEY must be 64 hex chars");
  return {
    publicUrl,
    port: Number(env("PORT", "8787")),
    dbPath: env("GATEWAY_DB", "./gateway.db"),
    webDir: env("GATEWAY_WEB_DIR", "../../app/out/web"),
    masterKey,
    sandbox: {
      driver,
      image: env("SANDBOX_IMAGE", "opentrade-sandbox"),
      flyApp: env("FLY_SANDBOX_APP", "opentrade-sandbox"),
      flyToken: optional("FLY_API_TOKEN"),
      flyRegion: env("FLY_SANDBOX_REGION", "iad"),
      gatewayUrlForSandbox: env("GATEWAY_URL_FOR_SANDBOX", publicUrl),
    },
    providers: {
      anthropicKey: optional("PLATFORM_ANTHROPIC_API_KEY"),
      openaiKey: optional("PLATFORM_OPENAI_API_KEY"),
    },
    stripe: {
      secretKey: optional("STRIPE_SECRET_KEY"),
      webhookSecret: optional("STRIPE_WEBHOOK_SECRET"),
    },
    push: {
      vapidPublic: optional("VAPID_PUBLIC_KEY"),
      vapidPrivate: optional("VAPID_PRIVATE_KEY"),
      vapidSubject: env("VAPID_SUBJECT", "mailto:support@opentrade.bot"),
    },
    creditMargin: Number(env("CREDIT_MARGIN", "1.3")),
    secureCookies: publicUrl.startsWith("https://"),
    adminToken: optional("GATEWAY_ADMIN_TOKEN"),
    demoEmails: (process.env.DEMO_ACCOUNT_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  };
}

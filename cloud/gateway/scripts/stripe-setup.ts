/**
 * Create (or find) OpenTrade Cloud's Stripe catalog and webhook. Idempotent: prices are
 * matched by lookup key, the webhook by URL. Run once per Stripe mode:
 *
 *   STRIPE_SECRET_KEY=sk_test_… GATEWAY_PUBLIC_URL=https://… bun scripts/stripe-setup.ts
 *
 * Prints the webhook signing secret when it creates the endpoint (Stripe shows it only
 * then): set it as STRIPE_WEBHOOK_SECRET on the gateway.
 */
import { CREDIT_PACKS, PLANS } from "../src/plans";

const key = process.env.STRIPE_SECRET_KEY;
const publicUrl = process.env.GATEWAY_PUBLIC_URL?.replace(/\/$/, "");
if (!key || !publicUrl) {
  console.error("set STRIPE_SECRET_KEY and GATEWAY_PUBLIC_URL");
  process.exit(1);
}

async function api(method: string, path: string, params: Record<string, string> = {}) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1${path}${method === "GET" ? `?${body}` : ""}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: method === "GET" ? undefined : body,
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${path}: ${json.error?.message}`);
  return json;
}

async function ensurePrice(opts: {
  lookupKey: string;
  product: string;
  description: string;
  cents: number;
  recurring: boolean;
}) {
  const existing = await api("GET", "/prices", { "lookup_keys[]": opts.lookupKey });
  if (existing.data.length) {
    console.log(`price ${opts.lookupKey}: exists (${existing.data[0].id})`);
    return;
  }
  const product = await api("POST", "/products", {
    name: opts.product,
    description: opts.description,
    "metadata[opentrade]": opts.lookupKey,
  });
  const price = await api("POST", "/prices", {
    product: product.id,
    currency: "usd",
    unit_amount: String(opts.cents),
    lookup_key: opts.lookupKey,
    ...(opts.recurring ? { "recurring[interval]": "month" } : {}),
  });
  console.log(`price ${opts.lookupKey}: created (${price.id})`);
}

for (const plan of Object.values(PLANS)) {
  if (!plan.lookupKey) continue;
  await ensurePrice({
    lookupKey: plan.lookupKey,
    product: `OpenTrade Cloud ${plan.name}`,
    description: `${plan.monthlyCredits.toLocaleString()} credits a month, up to ${plan.maxAgents} agents, always on.`,
    cents: plan.priceUsd * 100,
    recurring: true,
  });
}
for (const pack of CREDIT_PACKS) {
  await ensurePrice({
    lookupKey: pack.lookupKey,
    product: `OpenTrade credits (${pack.credits.toLocaleString()})`,
    description: `${pack.credits.toLocaleString()} OpenTrade credits. Never expire.`,
    cents: pack.priceUsd * 100,
    recurring: false,
  });
}

const url = `${publicUrl}/stripe/webhook`;
const hooks = await api("GET", "/webhook_endpoints", { limit: "100" });
if (hooks.data.some((h: { url: string }) => h.url === url)) {
  console.log(`webhook ${url}: exists`);
} else {
  const events = [
    "checkout.session.completed",
    "invoice.paid",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ];
  const params: Record<string, string> = { url, description: "OpenTrade Cloud gateway" };
  events.forEach((e, i) => {
    params[`enabled_events[${i}]`] = e;
  });
  const hook = await api("POST", "/webhook_endpoints", params);
  console.log(`webhook ${url}: created`);
  console.log(`STRIPE_WEBHOOK_SECRET=${hook.secret}`);
}

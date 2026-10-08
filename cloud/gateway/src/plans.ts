/**
 * Plans and model prices. Credits are cents of usage: 1 credit = $0.01 = 10_000 µ$,
 * debited at provider list price × the configured margin. A plan's monthly credits are
 * granted on each paid invoice; credit packs top up and never expire.
 */
export const MICROS_PER_CREDIT = 10_000;

export type PlanId = "free" | "pro" | "max";

export interface Plan {
  id: PlanId;
  name: string;
  priceUsd: number;
  monthlyCredits: number;
  maxAgents: number;
  /** Shortest schedule interval, in minutes, the plan allows (advisory in the UI). */
  minScheduleMinutes: number;
  /** Stripe Price lookup key (created by scripts/stripe-setup.ts). */
  lookupKey: string | null;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceUsd: 0,
    monthlyCredits: 0,
    maxAgents: 2,
    minScheduleMinutes: 30,
    lookupKey: null,
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsd: 29,
    monthlyCredits: 2_000,
    maxAgents: 5,
    minScheduleMinutes: 1,
    lookupKey: "opentrade_pro_monthly",
  },
  max: {
    id: "max",
    name: "Max",
    priceUsd: 99,
    monthlyCredits: 8_000,
    maxAgents: 25,
    minScheduleMinutes: 1,
    lookupKey: "opentrade_max_monthly",
  },
};

/** One-time credit packs. */
export const CREDIT_PACKS = [
  { id: "credits_1000", credits: 1_000, priceUsd: 10, lookupKey: "opentrade_credits_1000" },
  { id: "credits_5000", credits: 5_000, priceUsd: 45, lookupKey: "opentrade_credits_5000" },
] as const;

/** Credits every new account starts with, so the first agent runs before any key or card. */
export const SIGNUP_CREDITS = 200;

export function planOf(id: string | null | undefined): Plan {
  return PLANS[(id as PlanId) ?? "free"] ?? PLANS.free;
}

/** USD per million tokens. Cache writes/reads are priced as multiples of input. */
interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const ANTHROPIC: Array<[RegExp, ModelPrice]> = [
  [/haiku-4|haiku-5/, { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }],
  [/haiku/, { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 }],
  [/sonnet/, { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }],
  [
    /opus-4-(0|1)|opus-4$|claude-opus-4-20/,
    { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  ],
  [/opus|fable/, { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
];
// Unknown Anthropic model: bill as the most expensive current tier rather than undercharge.
const ANTHROPIC_FALLBACK: ModelPrice = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };

const OPENAI: Array<[RegExp, ModelPrice]> = [
  [/nano/, { input: 0.05, output: 0.4, cacheWrite: 0.05, cacheRead: 0.005 }],
  [/mini/, { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 }],
  [/gpt-5|codex|o4|o3/, { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 }],
];
const OPENAI_FALLBACK: ModelPrice = { input: 5, output: 20, cacheWrite: 5, cacheRead: 0.5 };

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function priceFor(provider: "anthropic" | "openai", model: string): ModelPrice {
  const table = provider === "anthropic" ? ANTHROPIC : OPENAI;
  for (const [re, price] of table) if (re.test(model)) return price;
  return provider === "anthropic" ? ANTHROPIC_FALLBACK : OPENAI_FALLBACK;
}

/** Provider list cost in µ$ (before margin). */
export function listCostMicros(
  provider: "anthropic" | "openai",
  model: string,
  u: TokenUsage,
): number {
  const p = priceFor(provider, model);
  const usd =
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite * p.cacheWrite) /
    1_000_000;
  return Math.ceil(usd * 1_000_000);
}

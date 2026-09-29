import type { PostHog } from "posthog-js";

/**
 * Website analytics — a deliberately small surface: pageviews (plus autocapture) for the
 * Web Analytics dashboard, and one event per call-to-action.
 *
 * This is a *separate* PostHog project from the app's telemetry (§12.3). The two share no
 * `distinct_id` — a browser visitor and an app install can't be joined — so keeping them
 * apart preserves the app project's curated event taxonomy, Persons list, and dashboards.
 *
 * Ingestion goes through exla's PostHog reverse proxy rather than `*.i.posthog.com`, the
 * same host the app uses, because a first-party-looking domain isn't eaten by ad blockers.
 * The proxy forwards `/static/*` as well as the ingest and flags endpoints, and reflects
 * CORS for arbitrary origins. It targets PostHog's **US** cloud, so the project whose key
 * is used here must live in the US region or events will be rejected.
 */
const POSTHOG_HOST = "https://r.exla.ai";

/** Where the PostHog app itself lives; without this, toolbar/"view in PostHog" links would
 *  point at the ingest proxy, which doesn't serve the UI. */
const POSTHOG_UI_HOST = "https://us.posthog.com";

/** The events this site sends through the SDK by hand. Pageviews/autocapture are automatic.
 *  The mailing-list signup (`email_subscribed`) bypasses the SDK — see `subscribeEmail`. */
export type WebsiteEvent = "download_clicked" | "github_clicked" | "x_clicked";

/**
 * Resolves once the SDK has loaded and initialised; null when analytics is inert.
 *
 * `posthog-js` is ~270 kB (~90 kB gzipped) — more than the rest of the page put together —
 * and nothing on screen depends on it, so it is imported dynamically. Vite emits it as its
 * own chunk that loads after the hero renders, rather than blocking first paint.
 */
let client: Promise<PostHog> | null = null;

/**
 * Boot PostHog. Inert without a key, and inert in dev, so a local `bun run dev` never
 * pollutes the project — mirroring the app's `analytics: inert (no key | dev)` behaviour.
 * The project API key is write-only and safe to ship in client JS.
 */
export function initAnalytics(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY ?? "";
  if (!key || !import.meta.env.PROD) return;

  client = import("posthog-js").then(({ default: posthog }) => {
    posthog.init(key, {
      api_host: POSTHOG_HOST,
      ui_host: POSTHOG_UI_HOST,
      defaults: "2025-05-24",
    });
    return posthog;
  });
}

/**
 * Record one of the site's own events. A no-op when analytics is inert. Safe to call before
 * the SDK finishes loading — the capture is chained onto the load, so an early click on a
 * CTA still lands rather than being dropped.
 */
export function track(event: WebsiteEvent): void {
  void client?.then((posthog) => posthog.capture(event));
}

/** Loose shape check; the input's `type="email"` does the user-facing validation. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Record a mailing-list signup as an `email_subscribed` event in the website's PostHog
 * project. PostHog is the only store: each address becomes a person (distinct id = the
 * lowercased address, `email` set as a person property), so repeat signups collapse onto
 * one person and the Persons list is the subscriber list.
 *
 * This posts straight to the capture endpoint rather than going through `posthog-js`,
 * because the SDK's `capture()` is fire-and-forget: a blocked or failed request would still
 * show the visitor a success message and silently lose the address. A direct `fetch` lets the
 * form report failure. Note the endpoint answers 200 for any well-formed payload (even an
 * unknown key), so a resolved promise means "reached ingestion", not "key verified".
 *
 * Rejects on a network error or non-2xx response. Inert like the rest of this module: with
 * no key, or in dev, it logs and resolves, so the form can be exercised locally.
 */
export async function subscribeEmail(rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!isValidEmail(email)) throw new Error("invalid email");

  const key = import.meta.env.VITE_POSTHOG_KEY ?? "";
  if (!key || !import.meta.env.PROD) {
    console.info("[analytics inert] email_subscribed", email);
    return;
  }

  const now = new Date().toISOString();
  const res = await fetch(`${POSTHOG_HOST}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event: "email_subscribed",
      distinct_id: email,
      timestamp: now,
      properties: {
        email,
        $current_url: window.location.href,
        $set: { email },
        $set_once: { email_subscribed_at: now },
      },
    }),
  });
  if (!res.ok) throw new Error(`capture failed: HTTP ${res.status}`);
}

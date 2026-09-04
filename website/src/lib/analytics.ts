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

/** The complete set of events this site sends by hand. Pageviews/autocapture are automatic. */
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

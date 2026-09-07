import { randomUUID } from "node:crypto";
import {
  asErrorCode,
  type ErrorSource,
  type ErrorSubsystem,
  errorCodeOf,
  errorNameOf,
  sanitizeStack,
  TELEMETRY_EVENTS,
  type TelemetryEvent,
  type TelemetryProps,
} from "@shared/analytics";
import {
  type FeedbackDiagnostics,
  FeedbackDiagnostics as FeedbackDiagnosticsSchema,
  type FeedbackInput,
} from "@shared/feedback";
import type { AppSettings } from "@shared/settings";
import { PostHog } from "posthog-node";
import type { z } from "zod";
import { hostLog } from "../../host/log";
import { bus } from "../event-bus";
import type { SettingsService } from "../settings";

/** exla's PostHog reverse proxy (→ PostHog cloud); the only endpoint the telemetry
 *  funnel talks to. Matches the `api_host` PostHog issues for this project. */
const POSTHOG_HOST = "https://r.exla.ai";

/**
 * The capture surface AnalyticsService needs — a subset of posthog-node's client,
 * so tests can inject a fake without the SDK or a network path.
 */
export interface CaptureClient {
  capture(msg: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    uuid?: string;
  }): void;
  /** Resolve once queued events are on the wire (rejects on a failed send). Only the
   *  feedback path awaits it — telemetry stays fire-and-forget. */
  flush(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}

/** How long `sendFeedback` waits for the flush before reporting failure. */
const FEEDBACK_FLUSH_TIMEOUT_MS = 8000;

/** Non-telemetry AppSettings keys we surface as `setting_changed`. */
const REPORTABLE_SETTING_KEYS = [
  "approvalTimeoutSec",
  "pollIntervalFocusedSec",
  "pollIntervalBlurredSec",
  "defaultApprovalMode",
  "onboardingComplete",
  "maxHeadlessTurns",
  "notifyWakes",
  "notifyOrders",
  "notifyApprovals",
  "notifyRestricted",
  "notifyUpdates",
  "showInMenuBar",
] as const;
// `notifyMutedAgents` is intentionally excluded — it carries agent ids, not a
// categorical/boolean value, so it isn't in the `settingKey` telemetry enum.

/**
 * The single telemetry funnel. Everything OpenTrade sends to PostHog goes through
 * `track()` here, in the backend host — the process that owns settings (the gate),
 * survives GUI restarts, and originates most events. There is no renderer PostHog
 * SDK: renderer/launcher events arrive over the `analytics.track` tRPC mutation.
 *
 * Privacy is structural: `track()` validates every payload against the strict
 * `TELEMETRY_EVENTS` allowlist and drops anything that doesn't parse. The distinct
 * id is a random per-install UUID (never a machine/user identifier). Events create a
 * PostHog person profile keyed by that anonymous id, carrying only the build metadata
 * we already send as event props (version/platform/arch) — never a machine or user
 * identifier. The profile is what makes Persons, cohorts and lifecycle work.
 *
 * Disabled ⇔ `client` is null (no key / dev / not started) **or** the user opted out
 * (`enabled`), checked live at capture time via `settings:changed`.
 */
export class AnalyticsService {
  private client: CaptureClient | null = null;
  private enabled = false;
  private distinctId = "";
  private superProps: Record<string, unknown> = {};
  private personProps: Record<string, unknown> = {};
  private lastSettings: AppSettings | null = null;
  private unsubs: Array<() => void> = [];
  private started = false;

  /**
   * Production init: create the posthog-node client from the build-time key unless
   * the key is absent or we're in dev without the `OPENTRADE_ANALYTICS_DEV=1`
   * override, then wire the settings gate + lifecycle. Inert (no client) otherwise.
   */
  init(opts: { settings: SettingsService }): void {
    const key = import.meta.env.MAIN_VITE_POSTHOG_API_KEY ?? "";
    const devDisabled = import.meta.env.DEV && process.env.OPENTRADE_ANALYTICS_DEV !== "1";
    let client: CaptureClient | null = null;
    if (key && !devDisabled) {
      client = new PostHog(key, {
        host: POSTHOG_HOST,
        flushAt: 1,
        flushInterval: 0,
        disableGeoip: true,
      });
      hostLog.info("analytics: enabled");
    } else {
      hostLog.info(`analytics: inert (${!key ? "no key" : "dev"})`);
    }
    this.start({ settings: opts.settings, client });
  }

  /**
   * Wire the service against a settings source + capture client. Split from init()
   * so tests can inject a fake client with no posthog-node/env dependency.
   */
  start(opts: { settings: SettingsService; client: CaptureClient | null }): void {
    if (this.started) return;
    this.started = true;
    this.client = opts.client;
    this.lastSettings = opts.settings.get();
    this.enabled = this.lastSettings.telemetryEnabled;
    this.distinctId = opts.settings.getOrCreate("telemetry_distinct_id", () => randomUUID());
    this.superProps = {
      app_version: process.env.OPENTRADE_VERSION ?? "dev",
      platform: process.platform,
      arch: process.arch,
    };
    // Person-profile properties: the same values we already send as event props, no
    // new data. `$set` tracks the install's current build; `$set_once` records where
    // it started — only the first event ever to land for this id sets those, so they
    // survive upgrades and give "new vs existing install" a real anchor.
    this.personProps = {
      $set: { ...this.superProps },
      $set_once: {
        first_seen_version: this.superProps.app_version,
        first_seen_at: new Date().toISOString(),
      },
    };
    this.unsubs.push(bus.onEvent("settings:changed", (next) => this.onSettingsChanged(next)));
    this.unsubs.push(bus.onEvent("gui:present", () => this.track("app_opened")));
  }

  /** The stable per-install anonymous id (exposed for tests). */
  get anonymousId(): string {
    return this.distinctId;
  }

  /**
   * Capture a telemetry event. Validated against the allowlist; a payload with an
   * unknown/extra prop (or an unknown event) is **dropped whole** — never partially
   * sent. Super-props + person properties are stamped here, not by callers.
   */
  track<E extends TelemetryEvent>(event: E, props?: TelemetryProps<E>): void {
    if (!this.client || !this.enabled) return;
    const schema = TELEMETRY_EVENTS[event] as z.ZodType | undefined;
    if (!schema) {
      hostLog.warn(`analytics: dropped ${String(event)} (unknown event)`);
      return;
    }
    const parsed = schema.safeParse(props ?? {});
    if (!parsed.success) {
      hostLog.warn(`analytics: dropped ${event} (invalid props)`);
      return;
    }
    try {
      this.client.capture({
        distinctId: this.distinctId,
        event,
        properties: {
          ...(parsed.data as Record<string, unknown>),
          ...this.superProps,
          ...this.personProps,
        },
      });
    } catch (err) {
      hostLog.warn(`analytics: capture failed: ${String(err)}`);
    }
  }

  /**
   * Capture a sanitized `app_error`: the error class name, its machine code when it
   * has one (`err.code` — e.g. `EADDRINUSE`), and a bundle-only stack fingerprint,
   * plus how it surfaced (`source`). Never the message, a stack line's path, or any
   * free text. `source` defaults to `caught` — the value for an explicit try/catch;
   * the global process handlers pass `uncaught_exception` / `unhandled_rejection`.
   * The code matters most for async Node system errors: their stack is entirely
   * `node:internal` frames (so `frames` is empty) and their class is plain `Error`,
   * leaving `error_code` as the only thing that says what actually went wrong.
   *
   * `codeOverride` is for a subsystem that knows the code by a route `errorCodeOf`
   * cannot take — the broker's `brokerErrorCode`, which resolves an `McpError`'s
   * *numeric* code (`-32001`) to its enum name. Without it those errors reach us as a
   * bare class name with no code at all. It is re-gated through `asErrorCode`, so an
   * override can only ever narrow to what the allowlist already accepts.
   */
  trackError(
    subsystem: ErrorSubsystem,
    err: unknown,
    source: ErrorSource = "caught",
    codeOverride?: string,
  ): void {
    const frames = sanitizeStack(err);
    const code = asErrorCode(codeOverride) ?? errorCodeOf(err);
    this.track("app_error", {
      subsystem,
      error_name: errorNameOf(err),
      ...(code ? { error_code: code } : {}),
      source,
      ...(frames.length ? { frames } : {}),
    });
  }

  /** Whether this build can send feedback at all — i.e. a PostHog client exists. The
   *  telemetry opt-out is deliberately NOT consulted (see `sendFeedback`). */
  get feedbackAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Send an in-app feedback submission (§12.8) as one `feedback_submitted` event. The
   * one capture that bypasses `track()`: free text, so not allowlisted, and **not gated
   * by `telemetryEnabled`** — clicking Send is the consent. Same anonymous install id;
   * nothing `$set` on the person profile. Awaits the flush so the UI gets a real
   * sent/failed outcome.
   */
  async sendFeedback(
    input: FeedbackInput,
    diagnostics: FeedbackDiagnostics | null,
  ): Promise<{ ok: boolean }> {
    const client = this.client;
    if (!client) return { ok: false };

    // Wire boundary for the diagnostics block: out-of-schema → dropped, message still goes.
    const diag = diagnostics ? FeedbackDiagnosticsSchema.safeParse(diagnostics) : null;
    if (diag && !diag.success) hostLog.warn("feedback: diagnostics failed schema, sending without");
    const block = diag?.success ? diag.data : null;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client.capture({
        // The draft's id: a retry after a timed-out flush (posthog-node keeps retrying in
        // the background) reuses it, so PostHog dedupes instead of storing two copies.
        uuid: input.submissionId,
        distinctId: this.distinctId,
        event: "feedback_submitted",
        properties: {
          message: input.message,
          ...(input.email ? { email: input.email } : {}),
          view: input.view,
          ...(block ?? {}),
        },
      });
      await Promise.race([
        client.flush(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("flush timeout")), FEEDBACK_FLUSH_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      hostLog.warn(`feedback: send failed: ${String(err)}`);
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }

    // The usage signal, through the normal allowlist + opt-out gate.
    this.track("feedback_sent", {
      with_email: Boolean(input.email),
      with_diagnostics: block !== null,
    });
    return { ok: true };
  }

  /** Flush pending events and stop listening. Bounded so host shutdown can't hang. */
  async shutdown(timeoutMs = 1500): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.shutdown(timeoutMs);
    } catch (err) {
      hostLog.warn(`analytics: shutdown flush failed: ${String(err)}`);
    }
  }

  private onSettingsChanged(next: AppSettings): void {
    const prev = this.lastSettings;
    this.lastSettings = next;
    if (!prev) return;

    // Telemetry toggle transitions. On opt-out, send the final event *before*
    // gating off (industry standard); on opt-in, gate on *before* sending.
    if (prev.telemetryEnabled && !next.telemetryEnabled) {
      this.track("telemetry_disabled");
      this.enabled = false;
      return;
    }
    if (!prev.telemetryEnabled && next.telemetryEnabled) {
      this.enabled = true;
      this.track("telemetry_enabled");
    }

    // Any other changed setting → one `setting_changed` (value only for enums/bools).
    for (const key of REPORTABLE_SETTING_KEYS) {
      if (prev[key] === next[key]) continue;
      const value = next[key];
      if (typeof value === "boolean" || key === "defaultApprovalMode") {
        this.track("setting_changed", {
          key,
          value: value as boolean | AppSettings["defaultApprovalMode"],
        });
      } else {
        this.track("setting_changed", { key });
      }
    }
  }
}

/** Host-wide singleton (same pattern as `bus`). Tests construct their own instances. */
export const analytics = new AnalyticsService();

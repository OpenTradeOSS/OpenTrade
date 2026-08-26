import { z } from "zod";
import { ApprovalMode, HarnessId } from "./agent";
import { NotificationKind } from "./notify";

/**
 * The telemetry allowlist — the single source of truth for what OpenTrade may ever
 * send to PostHog. Every event name maps to a **strict** schema of its allowed
 * props; the AnalyticsService validates each capture against this map and **drops
 * the whole event** if it doesn't parse (fail-closed). This is a structural privacy
 * guarantee, not a convention: an unexpected prop at a call site (a ticker, a raw
 * order object accidentally spread in) fails `strict` parsing and never leaves the
 * machine.
 *
 * Invariants enforced here:
 *  - No free-form `z.string()` anywhere. Every string is a `z.enum` or a tight
 *    regex (an identifier / a semver / a sanitized stack frame) — structurally
 *    unable to carry a message, path, or free text.
 *  - Numbers are durations/counts only.
 *  - Categorical normalizers (`assetTypeOf`, `sideOf`, `orderTypeOf`) map anything
 *    unrecognized to `"other"`, so raw parsed values can't pass through call sites.
 *
 * Policy: anonymous (a random distinct id, never a machine/user identifier), no
 * conversation data ever, and order events carry categories only — never tickers,
 * quantities, prices, notional, or account ids.
 */

// ---- shared field schemas ----

/** A bare identifier — an Error class name. Cannot carry a message/stack/path. */
const errorName = z.string().regex(/^[A-Za-z0-9_$]{1,64}$/);

/**
 * A machine error code — `err.code` when it is a bare identifier (Node system codes
 * like `EADDRINUSE`/`ECONNREFUSED`, `ERR_*`, our own `OAUTH_*`). Bounded token, no
 * spaces: structurally unable to carry a message. It's the one field that turns a
 * bare `Error` (whose class name says nothing) into something diagnosable.
 */
const errorCode = z.string().regex(/^[A-Za-z0-9_]{1,48}$/);

/** A semver-ish version string. */
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);

/**
 * A sanitized stack frame: `<bundle>.js:line[:col]` for our own bundles, or
 * `<pkg>/<file>.js:line[:col]` for a frame inside a dependency. Never more than a
 * package name plus a basename, so it points at code without carrying a directory
 * (no user path) or a message.
 */
const MAX_STACK_FRAME = 128;
const stackFrame = z
  .string()
  .max(MAX_STACK_FRAME)
  .regex(/^(?:(?:@[\w.-]+\/)?[\w.-]+\/)?[\w.-]+\.js:\d+(?::\d+)?$/);
const frames = z.array(stackFrame).max(10);

const assetType = z.enum(["equity", "option", "other"]);
const orderSide = z.enum(["buy", "sell", "other"]);
const orderType = z.enum(["market", "limit", "other"]);
const orderKind = z.enum(["place", "cancel"]);

/** Subsystem an `app_error` originated in. */
export const ErrorSubsystem = z.enum([
  "host",
  "broker",
  "terminal",
  "scheduler",
  "wake",
  "approvals",
  "updater",
  "renderer",
]);
export type ErrorSubsystem = z.infer<typeof ErrorSubsystem>;

/**
 * How an `app_error` reached the reporter — the *capture mechanism*, not the error
 * itself. Because we deliberately never send the message, this is the cheapest way
 * to make triage tractable: it separates an uncaught throw from an unhandled promise
 * rejection (e.g. a background clipboard write denied while the window is unfocused)
 * without any free text. `caught` is an explicit try/catch that chose to report.
 * Process-agnostic — the renderer's `error` / `unhandledrejection` window listeners and
 * the host's `uncaughtException` / `unhandledRejection` handlers map onto the same three.
 */
export const ErrorSource = z.enum(["uncaught_exception", "unhandled_rejection", "caught"]);
export type ErrorSource = z.infer<typeof ErrorSource>;

/** Keys of the global AppSettings (kept in sync manually — the enum is the guard). */
const settingKey = z.enum([
  "approvalTimeoutSec",
  "pollIntervalFocusedSec",
  "pollIntervalBlurredSec",
  "defaultApprovalMode",
  "onboardingComplete",
  "telemetryEnabled",
  "maxHeadlessTurns",
  "notifyWakes",
  "notifyOrders",
  "notifyApprovals",
  "notifyRestricted",
  "notifyUpdates",
  "showInMenuBar",
]);

/** Onboarding step ids (mirrors renderer/screens/Onboarding.tsx). */
export const OnboardingStep = z.enum(["claude", "broker", "showcase", "agent"]);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

/** Agent template ids (mirrors templates/agents/*). */
const agentTemplate = z.enum(["default", "dca", "momentum", "blank", "other"]);

// ---- the event → prop-schema map ----

/**
 * Every telemetry event and its exact allowed props. `z.strictObject` rejects any
 * unknown key, so a mistake at a call site drops the event rather than leaking.
 */
export const TELEMETRY_EVENTS = {
  // lifecycle
  host_started: z.strictObject({ after_crash: z.boolean().optional() }),
  app_opened: z.strictObject({}),
  app_updated: z.strictObject({ from_version: version, to_version: version }),
  update_downloaded: z.strictObject({ to_version: version }),

  // onboarding funnel
  onboarding_started: z.strictObject({}),
  onboarding_step_completed: z.strictObject({ step: OnboardingStep }),
  onboarding_completed: z.strictObject({}),

  // agents
  agent_created: z.strictObject({
    template: agentTemplate,
    harness: HarnessId,
    approval_mode: ApprovalMode,
  }),
  agent_archived: z.strictObject({}),
  agent_restarted: z.strictObject({}),
  terminal_session_started: z.strictObject({ intent: z.enum(["auto", "resume", "fresh"]) }),
  terminal_respawned: z.strictObject({}),

  // orders / the approval gate (categorical only)
  order_gate_prompted: z.strictObject({
    kind: orderKind,
    asset_type: assetType,
    side: orderSide,
    order_type: orderType,
    mode: ApprovalMode,
  }),
  order_gate_decided: z.strictObject({
    decision: z.enum(["approved", "rejected", "expired"]),
    decided_by: z.enum(["user", "auto", "timeout"]),
    decision_ms: z.number().int().nonnegative(),
    kind: orderKind,
    asset_type: assetType,
    side: orderSide,
    order_type: orderType,
  }),
  order_submit_resolved: z.strictObject({ result: z.enum(["ok", "rejected", "unknown"]) }),

  // broker
  /** Top of the connect funnel; `connected` / `connect_failed` are the outcomes. The gap
   *  is attempts with no outcome event: superseded by a later click, still pending, or a
   *  silent connect that found a dead grant and quietly stayed disconnected. */
  broker_connect_started: z.strictObject({ mode: z.enum(["interactive", "silent"]) }),
  broker_connected: z.strictObject({}),
  broker_connect_failed: z.strictObject({
    error_name: errorName,
    error_code: errorCode.optional(),
  }),
  /**
   * The poll loop lost the network (laptop sleep/wake, Wi‑Fi blip): once per outage,
   * with the first failure's code, instead of an `app_error` per failed poll. Not an
   * error in the app — filter it out of error dashboards. `broker_online` closes it.
   */
  broker_offline: z.strictObject({ error_code: errorCode.optional() }),
  broker_online: z.strictObject({
    offline_ms: z.number().int().nonnegative(),
    failed_polls: z.number().int().nonnegative(),
  }),

  // autonomy
  schedule_created: z.strictObject({
    kind: z.enum(["cron", "monitor"]),
    recurring: z.boolean().optional(),
  }),
  schedule_fired: z.strictObject({
    source: z.enum(["cron", "monitor"]),
    path: z.enum(["warm", "headless"]),
  }),
  headless_run_finished: z.strictObject({
    result: z.enum(["ok", "resume_fail", "spawn_fail"]),
    duration_ms: z.number().int().nonnegative(),
  }),
  agent_marked_broken: z.strictObject({}),
  turn_limit_reached: z.strictObject({}),

  // settings + telemetry lifecycle
  setting_changed: z.strictObject({
    key: settingKey,
    value: z.union([z.boolean(), ApprovalMode]).optional(),
  }),
  telemetry_enabled: z.strictObject({}),
  telemetry_disabled: z.strictObject({}),

  // notifications
  notification_clicked: z.strictObject({ kind: NotificationKind }),

  // errors (sanitized)
  app_error: z.strictObject({
    subsystem: ErrorSubsystem,
    error_name: errorName,
    error_code: errorCode.optional(),
    source: ErrorSource.optional(),
    frames: frames.optional(),
  }),
} as const;

export type TelemetryEvent = keyof typeof TELEMETRY_EVENTS;

/** Props type for a given event (the parsed/validated shape). */
export type TelemetryProps<E extends TelemetryEvent> = z.infer<(typeof TELEMETRY_EVENTS)[E]>;

/**
 * The subset of events the renderer/launcher may emit over the `analytics.track`
 * tRPC mutation. A discriminated union so the tRPC surface can't be used to smuggle
 * host-only events or extra props; the host re-validates through TELEMETRY_EVENTS
 * regardless. `app_error` here is restricted to the two subsystems that actually run
 * in the GUI process and relay over this surface — `renderer` and `updater` (the
 * auto-updater lives in the Electron main process, not the host) — so it still can't
 * smuggle a host-only subsystem label.
 */
export const RendererTrackInput = z.discriminatedUnion("event", [
  z.object({ event: z.literal("onboarding_started") }),
  z.object({
    event: z.literal("onboarding_step_completed"),
    props: TELEMETRY_EVENTS.onboarding_step_completed,
  }),
  z.object({ event: z.literal("onboarding_completed") }),
  z.object({ event: z.literal("update_downloaded"), props: TELEMETRY_EVENTS.update_downloaded }),
  z.object({
    event: z.literal("notification_clicked"),
    props: TELEMETRY_EVENTS.notification_clicked,
  }),
  z.object({
    event: z.literal("app_error"),
    props: z.strictObject({
      subsystem: z.enum(["renderer", "updater"]),
      error_name: errorName,
      // Same bounded token as the host path (see `errorCode`). The updater's failures
      // arrive as a bare `Error` from electron-updater — no useful class name and, when
      // the throw is a network failure, often no frames of ours either — so without the
      // code a failed update check is indistinguishable from any other.
      error_code: errorCode.optional(),
      source: ErrorSource.optional(),
      frames: frames.optional(),
    }),
  }),
]);
export type RendererTrackInput = z.infer<typeof RendererTrackInput>;

// ---- categorical normalizers (call sites pass raw values through these) ----

/** equity vs option, from the Robinhood order tool name. */
export function assetTypeOf(toolName: string): z.infer<typeof assetType> {
  if (/_equity_/.test(toolName)) return "equity";
  if (/_option_/.test(toolName)) return "option";
  return "other";
}

/** buy/sell/other from a parsed order side (any casing). */
export function sideOf(side: string | null | undefined): z.infer<typeof orderSide> {
  const s = (side ?? "").toLowerCase();
  return s === "buy" || s === "sell" ? s : "other";
}

/** market/limit/other from a parsed order type (any casing). */
export function orderTypeOf(type: string | null | undefined): z.infer<typeof orderType> {
  const t = (type ?? "").toLowerCase();
  return t === "market" || t === "limit" ? t : "other";
}

/** place vs cancel from a parsed order kind. */
export function orderKindOf(kind: string | null | undefined): z.infer<typeof orderKind> {
  return kind === "cancel" ? "cancel" : "place";
}

/** Normalize a template id to the allowlist (unknown → "other"). */
export function templateOf(template: string | null | undefined): z.infer<typeof agentTemplate> {
  switch (template) {
    case "default":
    case "dca":
    case "momentum":
    case "blank":
      return template;
    default:
      return "other";
  }
}

/**
 * Extract a sanitized stack fingerprint from an error: at most 10 frames, each
 * `<bundle>.js:line[:col]` for our own bundles or `<pkg>/<file>.js:line[:col]` for a
 * frame inside a dependency. Node internals are dropped — their line numbers move with
 * the runtime, and the error's class plus `error_code` already say what happened.
 *
 * Dependency frames are deliberately **kept**: host-process errors are overwhelmingly
 * thrown inside one (the broker's inside `@modelcontextprotocol/sdk`, the updater's
 * inside `electron-updater`), so dropping them left every backend `app_error` with no
 * stack at all, while renderer errors — thrown in our own bundle — kept theirs.
 *
 * Taking only the file **basename**, plus for a dependency the package name resolved
 * from after the last `node_modules/`, structurally strips any directory, so no user
 * path or message can ride along.
 */
export function sanitizeStack(err: unknown): string[] {
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  if (!stack) return [];
  const out: string[] = [];
  const re = /([\w.-]+\.js):(\d+)(?::(\d+))?/;
  for (const line of stack.split("\n")) {
    // Only real frames. The first line of a stack is `<Class>: <message>` — free text,
    // and on an `McpError` server-influenced — so mining it for a `file.js:line` would
    // turn a message into telemetry. It also bounds the work `re` does per line.
    if (!/^\s+at /.test(line)) continue;
    if (/node:internal/.test(line)) continue;
    const m = line.match(re);
    if (!m) continue;
    const at = m[3] ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`;
    const pkg = packageOf(line);
    // Length is enforced here, not only in the schema: a frame over the cap would fail
    // validation and drop the **whole** event, losing the other nine good frames with
    // it. Degrade instead — shed the package prefix, then the frame itself.
    const frame = pkg ? `${pkg}/${at}` : at;
    if (frame.length <= MAX_STACK_FRAME) out.push(frame);
    else if (at.length <= MAX_STACK_FRAME) out.push(at);
    else continue;
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * The npm package a stack line points into — `name` or `@scope/name` — read from after
 * the **last** `node_modules/`, so a nested dependency resolves to the package that
 * actually owns the frame. Null when the line is not inside a dependency, or when the
 * segment does not look like a package name; the frame then degrades to its bare
 * basename rather than carrying through anything unexpected.
 */
function packageOf(line: string): string | null {
  // The marker must be a whole path segment. A bare `indexOf("node_modules/")` also
  // fires on a *user* directory merely ending in it (`~/my-node_modules/Acme-Client/`),
  // which would publish that directory's name as if it were a package. Both separators
  // are accepted so the labelling works on Windows too.
  let after = -1;
  for (const m of line.matchAll(/(?:^|[/\\(\s])node_modules[/\\]/g)) {
    after = (m.index ?? 0) + m[0].length;
  }
  if (after === -1) return null;
  const seg = line.slice(after).split(/[/\\]/);
  const name = seg[0]?.startsWith("@") ? `${seg[0]}/${seg[1] ?? ""}` : (seg[0] ?? "");
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) return null;
  // `.`/`..` satisfy the charset but are traversal, not a package.
  return /(?:^|\/)\.\.?$/.test(name) ? null : name;
}

/** The constructor name of a thrown value, normalized to the `error_name` shape. */
export function errorNameOf(err: unknown): string {
  const name =
    err instanceof Error
      ? err.name || err.constructor?.name || "Error"
      : typeof err === "object" && err
        ? (err.constructor?.name ?? "Object")
        : typeof err;
  // Keep only identifier chars; guarantee the `errorName` regex passes.
  const clean = name.replace(/[^A-Za-z0-9_$]/g, "").slice(0, 64);
  return clean || "Error";
}

/**
 * The machine code of a thrown value — `err.code`, or failing that `err.cause.code` —
 * or undefined unless it *already* fits the `errorCode` shape: nothing is coerced or
 * truncated into one, so a `code` holding a message/path is dropped, not leaked.
 * Numeric codes (DOMException) are ignored: meaningless without the class name, which
 * `errorNameOf` carries.
 *
 * The `cause` hop is for undici: every network failure `fetch` throws is a bare
 * `TypeError: fetch failed` with no code of its own — the useful token
 * (`ENOTFOUND`, `ECONNRESET`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, …) sits on
 * `.cause` (Node also copies it onto the `AggregateError` for dual-stack hosts). One
 * level only.
 */
export function errorCodeOf(err: unknown): string | undefined {
  const codeOn = (v: unknown) =>
    typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined;
  return asErrorCode(codeOn(err) ?? codeOn((err as { cause?: unknown } | null)?.cause));
}

/**
 * A value as an `error_code`, or undefined — nothing is coerced or truncated into one.
 * The single gate for the field, used both by `errorCodeOf`'s discovery and by a caller
 * that already knows the code by another route (see `brokerErrorCode`, which resolves an
 * `McpError`'s *numeric* code to its enum name). Keeping the check here means a
 * caller-supplied code can never widen what the allowlist accepts — and, since a prop
 * that fails validation drops the **whole** event, can never cost us an `app_error`.
 */
export function asErrorCode(value: unknown): string | undefined {
  return errorCode.safeParse(value).success ? (value as string) : undefined;
}

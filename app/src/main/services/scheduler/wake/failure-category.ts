import type { WakeFailureCategory } from "@shared/analytics";

/**
 * Map Claude Code's `StopFailure` hook `error` value (the turn ended in an API error)
 * onto the same coarse category. The hook's enum is finer than ours: the credential
 * states all read as `auth`, throttling/overload as `rate_limit`, `server_error` (a 5xx
 * OR a connection failure — Claude doesn't distinguish) as `network`, and what's left —
 * bad requests, unknown model, output cap, unknown — as `other`.
 */
export function categoryForStopFailure(error: string): WakeFailureCategory {
  switch (error) {
    case "billing_error":
      return "billing";
    case "rate_limit":
    case "overloaded":
      return "rate_limit";
    case "server_error":
      return "network";
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
    case "cloud_credential_error":
      return "auth";
    default:
      return "other";
  }
}

/**
 * Classify a failed headless run's error text into the coarse `WakeFailureCategory`
 * that ships on `wake_finished`. The input — the claude CLI's stderr tail or
 * a codex turn error — never leaves the machine (it lands in the host log); only the
 * returned category is tracked, so the patterns here can afford to be broad.
 *
 * Ordering matters where texts could match twice: an unresumable-session line is the
 * most specific signal, so it wins; anything unrecognized falls through to `other`
 * rather than guessing.
 */
export function classifyWakeFailure(text: string): WakeFailureCategory {
  // "No conversation found with session ID <uuid>" (claude), "thread ... not found" (codex).
  if (
    /no conversation found|session[^\n]{0,40}not found|thread[^\n]{0,40}not found|unable to resume/i.test(
      text,
    )
  ) {
    return "unknown_session";
  }
  // "Credit balance is too low" — the incident that motivated stderr capture. HTTP
  // status codes are digit-bounded: the tail is full of numbers (epoch reset stamps,
  // `40200ms` durations, request ids) that must not read as a 402/429/401.
  if (/credit balance|billing|payment required|(?<!\d)402(?!\d)/i.test(text)) {
    return "billing";
  }
  // "Claude AI usage limit reached|<ts>", API 429s, overloaded upstream.
  if (/usage limit|rate.?limit|(?<!\d)429(?!\d)|overloaded/i.test(text)) {
    return "rate_limit";
  }
  // "Invalid API key · Please run /login", expired/revoked OAuth tokens. `login` is
  // word-bounded ("/login", "log in") so a stray "logging ..." stderr line can't
  // hijack the category.
  if (
    /api key|oauth|\blog ?in\b|authentication|unauthorized|(?<!\d)401(?!\d)|token[^\n]{0,20}(expired|revoked)|credentials/i.test(
      text,
    )
  ) {
    return "auth";
  }
  // The API never answered: undici/Node transport codes (word-bounded both sides),
  // "fetch failed", claude's own "Connection refused/reset" phrasing, a whole-word
  // "timed out"/"timeout" (not TIMEOUT_MS or "timeouts"), and 5xx statuses incl. the
  // Cloudflare 520–524 origin errors the API's edge emits. The status is digit-bounded
  // like the codes above AND must not be a duration ("500ms", "500s"), which is far more
  // common in a stderr tail than a bare 5xx.
  if (
    /fetch failed|connection (refused|reset|closed|error)|socket hang up|network error|\bE(CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN|TIMEDOUT|HOSTUNREACH|NETUNREACH)\b|UND_ERR_|\btimed? ?out\b|(?<!\d)5(00|02|03|04|2[0-4])(?!\d|\s?m?s\b)/i.test(
      text,
    )
  ) {
    return "network";
  }
  return "other";
}

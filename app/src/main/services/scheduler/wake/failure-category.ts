import type { WakeFailureCategory } from "@shared/analytics";

/**
 * Classify a failed headless run's error text into the coarse `WakeFailureCategory`
 * that ships on `headless_run_finished`. The input — the claude CLI's stderr tail or
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
  return "other";
}

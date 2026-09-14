import { describe, expect, test } from "bun:test";
import { categoryForStopFailure, classifyWakeFailure } from "./failure-category";

describe("classifyWakeFailure", () => {
  test("unresumable-session lines from both harnesses", () => {
    expect(
      classifyWakeFailure(
        "No conversation found with session ID 01a058e6-46da-7604-8712-4868fb29395f",
      ),
    ).toBe("unknown_session");
    expect(classifyWakeFailure("Error: thread abc123 not found")).toBe("unknown_session");
    expect(classifyWakeFailure("session was not found on disk")).toBe("unknown_session");
    expect(classifyWakeFailure("unable to resume conversation")).toBe("unknown_session");
  });

  test("billing", () => {
    expect(classifyWakeFailure("Credit balance is too low")).toBe("billing");
    expect(classifyWakeFailure('API Error: 402 {"type":"error"}')).toBe("billing");
  });

  test("rate limits and usage caps", () => {
    expect(classifyWakeFailure("Claude AI usage limit reached|1735689600")).toBe("rate_limit");
    expect(
      classifyWakeFailure('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'),
    ).toBe("rate_limit");
    expect(classifyWakeFailure("Overloaded")).toBe("rate_limit");
    // A reset timestamp containing "402" as a digit substring must not read as a 402:
    // the same real-world line would otherwise flip to billing depending on the epoch.
    expect(classifyWakeFailure("Claude AI usage limit reached|1740234567")).toBe("rate_limit");
  });

  test("auth", () => {
    expect(classifyWakeFailure("Invalid API key · Please run /login")).toBe("auth");
    expect(classifyWakeFailure("OAuth token has expired. Please obtain a new token.")).toBe("auth");
    expect(classifyWakeFailure('API Error: 401 {"type":"error"}')).toBe("auth");
  });

  test("session-not-found wins over other keywords in the same tail", () => {
    // A tail can carry several lines; the unresumable-session signal is the most
    // specific and must win over a generic auth-ish word later in the buffer.
    expect(classifyWakeFailure("No conversation found with session ID x\nPlease run /login")).toBe(
      "unknown_session",
    );
  });

  test("unrecognized text fails closed to other", () => {
    expect(classifyWakeFailure("")).toBe("other");
    expect(classifyWakeFailure("segmentation fault")).toBe("other");
    expect(classifyWakeFailure("spawn claude ENOENT")).toBe("other"); // a missing binary, not the network
  });

  test("digit substrings and near-miss words don't fake a category", () => {
    // Status codes are digit-bounded: durations, request ids, and byte counts in the
    // 2000-char tail are full of 401/402/429 substrings that are not HTTP statuses.
    expect(classifyWakeFailure("Request timed out after 40200ms")).toBe("network"); // the 402 inside 40200 is not billing
    expect(classifyWakeFailure("stream error: retrying in 4013ms")).toBe("other");
    // The 429 inside the request id is not a rate limit; the 500 IS a server error.
    expect(classifyWakeFailure("request_id: req_011CR4291abc failed with status 500")).toBe(
      "network",
    );
    // "logging"/"dialog" must not read as "login".
    expect(classifyWakeFailure("Error while logging to stderr file")).toBe("other");
    expect(classifyWakeFailure("error dialog initialization failed")).toBe("other");
  });

  test("network: transport codes, fetch failures, claude's connection wording, 5xx", () => {
    expect(classifyWakeFailure("TypeError: fetch failed")).toBe("network");
    expect(classifyWakeFailure("Error: connect ECONNREFUSED 127.0.0.1:443")).toBe("network");
    expect(classifyWakeFailure("getaddrinfo ENOTFOUND api.anthropic.com")).toBe("network");
    expect(
      classifyWakeFailure(
        "API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)",
      ),
    ).toBe("network");
    expect(classifyWakeFailure("API Error: 503 overloaded_error")).toBe("rate_limit"); // overloaded wins
    expect(classifyWakeFailure("API Error: 502 Bad Gateway")).toBe("network");
    expect(classifyWakeFailure("API Error: 522 origin connection time-out")).toBe("network"); // Cloudflare edge
    expect(classifyWakeFailure("request timed out after 60000ms")).toBe("network");
    // Word-bounded: identifiers and near-miss words containing the patterns don't count.
    expect(classifyWakeFailure("TIMEOUT_MS=300 budget exceeded")).toBe("other");
    expect(classifyWakeFailure("HOMECONNRESET=1")).toBe("other");
    expect(classifyWakeFailure("waited 500s for approval")).toBe("other");
    // Digit-bounded AND not a duration: "15020ms" and "500ms" are not statuses.
    expect(classifyWakeFailure("retrying in 15020ms")).toBe("other");
    expect(classifyWakeFailure("retrying in 500ms")).toBe("other");
    expect(classifyWakeFailure("took 503 ms")).toBe("other");
  });

  test("the fatal line wins over preceding noise lines in a multi-line tail", () => {
    const tail =
      "[debug] logging initialized\n[warn] retrying in 4013ms\nAPI Error: 429 rate_limit_error";
    expect(classifyWakeFailure(tail)).toBe("rate_limit");
  });
});

describe("categoryForStopFailure", () => {
  test("maps Claude Code's StopFailure `error` enum onto the coarse category", () => {
    expect(categoryForStopFailure("billing_error")).toBe("billing");
    expect(categoryForStopFailure("rate_limit")).toBe("rate_limit");
    expect(categoryForStopFailure("overloaded")).toBe("rate_limit");
    for (const e of [
      "authentication_failed",
      "oauth_org_not_allowed",
      "account_on_hold",
      "verification_required",
      "cloud_credential_error",
    ]) {
      expect(categoryForStopFailure(e)).toBe("auth");
    }
  });

  test("server_error (a 5xx or a connection failure) reads as `network`", () => {
    expect(categoryForStopFailure("server_error")).toBe("network");
  });

  test("everything the category can't express reads as `other`", () => {
    for (const e of [
      "invalid_request",
      "model_not_found",
      "max_output_tokens",
      "unknown",
      "", // hook payload without an error field
      "some_future_value",
    ]) {
      expect(categoryForStopFailure(e)).toBe("other");
    }
  });
});

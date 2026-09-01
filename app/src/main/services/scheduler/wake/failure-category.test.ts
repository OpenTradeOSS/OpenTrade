import { describe, expect, test } from "bun:test";
import { classifyWakeFailure } from "./failure-category";

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
    expect(classifyWakeFailure("TypeError: fetch failed")).toBe("other");
    expect(classifyWakeFailure("spawn claude ENOENT")).toBe("other");
  });

  test("digit substrings and near-miss words don't fake a category", () => {
    // Status codes are digit-bounded: durations, request ids, and byte counts in the
    // 2000-char tail are full of 401/402/429 substrings that are not HTTP statuses.
    expect(classifyWakeFailure("Request timed out after 40200ms")).toBe("other");
    expect(classifyWakeFailure("stream error: retrying in 4013ms")).toBe("other");
    expect(classifyWakeFailure("request_id: req_011CR4291abc failed with status 500")).toBe(
      "other",
    );
    // "logging"/"dialog" must not read as "login".
    expect(classifyWakeFailure("Error while logging to stderr file")).toBe("other");
    expect(classifyWakeFailure("error dialog initialization failed")).toBe("other");
  });

  test("the fatal line wins over preceding noise lines in a multi-line tail", () => {
    const tail =
      "[debug] logging initialized\n[warn] retrying in 4013ms\nAPI Error: 429 rate_limit_error";
    expect(classifyWakeFailure(tail)).toBe("rate_limit");
  });
});

import { describe, expect, test } from "bun:test";
import { FeedbackDiagnostics, FeedbackInput } from "./feedback";

// Zod's own behaviour isn't under test here — only the two guarantees the privacy
// boundary rests on: both schemas are strict, and a blank email must be absent, not "".
describe("feedback schemas", () => {
  const input = {
    submissionId: "3f1c2b6e-8c1a-4a4b-9d0e-1a2b3c4d5e6f",
    message: "hi",
    includeDiagnostics: false,
    view: "agents",
  };

  test("FeedbackInput rejects an extra field and a blank-string email", () => {
    expect(FeedbackInput.safeParse(input).success).toBe(true);
    expect(FeedbackInput.safeParse({ ...input, ticker: "AAPL" }).success).toBe(false);
    expect(FeedbackInput.safeParse({ ...input, email: "" }).success).toBe(false);
  });

  test("FeedbackDiagnostics rejects an extra field and a path-shaped version", () => {
    const result = FeedbackDiagnostics.safeParse({ home: "/Users/someone" });
    expect(result.success).toBe(false);
    expect(FeedbackDiagnostics.shape.claude_version.safeParse("/usr/local/bin").success).toBe(
      false,
    );
    expect(FeedbackDiagnostics.shape.claude_version.safeParse("2.0.1 (Claude Code)").success).toBe(
      true,
    );
  });
});

import { describe, expect, test } from "bun:test";
import { type KeyLike, NEWLINE_SEQUENCE, shiftEnterToNewline } from "./keys";

const key = (over: Partial<KeyLike>): KeyLike => ({
  type: "keydown",
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});

describe("shiftEnterToNewline", () => {
  test("Shift+Enter keydown sends ESC CR and is swallowed", () => {
    expect(shiftEnterToNewline(key({ shiftKey: true }))).toEqual({
      passThrough: false,
      send: NEWLINE_SEQUENCE,
    });
    expect(NEWLINE_SEQUENCE).toBe("\x1b\r");
  });

  test("keypress/keyup of Shift+Enter are swallowed without sending again", () => {
    for (const type of ["keypress", "keyup"]) {
      expect(shiftEnterToNewline(key({ type, shiftKey: true }))).toEqual({ passThrough: false });
    }
  });

  test("an IME composition confirm isn't turned into a newline", () => {
    expect(shiftEnterToNewline(key({ shiftKey: true, isComposing: true }))).toEqual({
      passThrough: false,
    });
  });

  test("plain Enter, other modifiers and other keys pass through to xterm", () => {
    expect(shiftEnterToNewline(key({}))).toEqual({ passThrough: true });
    for (const mod of ["ctrlKey", "altKey", "metaKey"] as const) {
      expect(shiftEnterToNewline(key({ shiftKey: true, [mod]: true })).passThrough).toBe(true);
    }
    expect(shiftEnterToNewline(key({ key: "a", shiftKey: true })).passThrough).toBe(true);
  });
});

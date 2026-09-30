/** The key fields xterm's custom key handler sees (a DOM KeyboardEvent in the app). */
export interface KeyLike {
  type: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

/** ESC CR — the Meta/Option+Enter sequence both agent CLIs read as "insert newline". */
export const NEWLINE_SEQUENCE = "\x1b\r";

/**
 * Shift+Enter → newline in the agent's prompt. xterm sends a bare CR for Enter
 * regardless of Shift (the modifier isn't encodable without the kitty keyboard
 * protocol), so the agent would submit. Instead send ESC CR: Claude Code treats it as
 * newline (what its `/terminal-setup` wires up for terminals like VS Code's) and Codex
 * parses it as Alt+Enter, one of its `insert_newline` bindings. Plain Enter still
 * submits in both.
 *
 * Returns what xterm's `attachCustomKeyEventHandler` needs: whether xterm should
 * process the event itself, and the bytes to send instead (keydown only). Every phase
 * of Shift+Enter is swallowed so xterm never also emits its CR.
 */
export function shiftEnterToNewline(e: KeyLike): { passThrough: boolean; send?: string } {
  if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
    return { passThrough: true };
  }
  if (e.type === "keydown" && !e.isComposing) return { passThrough: false, send: NEWLINE_SEQUENCE };
  return { passThrough: false };
}

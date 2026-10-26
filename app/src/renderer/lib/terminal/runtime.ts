import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const RESIZE_DEBOUNCE_MS = 75;

/** Terminal theme derived from the app's dark OKLCH palette (approximate sRGB). */
const THEME = {
  background: "#1c1c1c",
  foreground: "#fafafa",
  cursor: "#fafafa",
  selectionBackground: "#3a3a3a",
  black: "#1c1c1c",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c0caf5",
  brightBlack: "#5a5a5a",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#ffffff",
};

/**
 * Focus-tolerant clipboard provider for xterm's ClipboardAddon.
 *
 * The addon handles OSC 52 escape sequences — a program running in the terminal
 * (e.g. the agent) asking to set/read the system clipboard — by calling
 * `navigator.clipboard.{writeText,readText}`. When the OpenTrade window is not
 * focused at that moment, Chromium rejects the call with a `NotAllowedError`
 * ("Document is not focused"). This is unavoidable (the browser forbids clipboard
 * access without focus) and harmless — the copy simply doesn't land.
 *
 * The stock provider lets that rejection escape unhandled, where our renderer
 * error reporter picks it up and files it as a spurious `app_error`
 * (`NotAllowedError`, subsystem "renderer"). We swallow it here to keep that
 * benign, uncontrollable failure out of telemetry. Behavior is unchanged: the
 * clipboard write was already failing either way; we only stop it from surfacing
 * as an unhandled rejection. Errors from any *other* code path still report
 * normally — we're muting only the clipboard case, not `NotAllowedError` globally.
 */
const clipboardProvider: IClipboardProvider = {
  readText: (_selection) => navigator.clipboard.readText().catch(() => ""),
  writeText: (_selection, text) => navigator.clipboard.writeText(text).catch(() => {}),
};

export interface TerminalRuntime {
  terminal: XTerm;
  fit: FitAddon;
  /** The terminal's DOM host; mounted into the visible pane container. */
  wrapper: HTMLDivElement;
  lastCols: number;
  lastRows: number;
  dispose: () => void;
}

export interface RuntimeCallbacks {
  onUserInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

/**
 * A single, agent-agnostic xterm instance. In the viewport model one runtime is
 * reused across agents: the session controller resets it and reattaches (with
 * ring-buffer replay) on every agent switch, so there is no per-agent terminal
 * state to keep alive.
 */
export function createRuntime(cb: RuntimeCallbacks): TerminalRuntime {
  const wrapper = document.createElement("div");
  wrapper.style.width = "100%";
  wrapper.style.height = "100%";

  const terminal = new XTerm({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", "MesloLGS Nerd Font", Menlo, Monaco, monospace',
    fontSize: 13,
    theme: THEME,
    allowProposedApi: true,
    scrollback: 10000,
    macOptionIsMeta: false,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
  });

  const fit = new FitAddon();
  const search = new SearchAddon();
  const unicode11 = new Unicode11Addon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(unicode11);
  terminal.unicode.activeVersion = "11";
  terminal.loadAddon(new ClipboardAddon(undefined, clipboardProvider));

  terminal.open(wrapper);

  // WebGL renderer with graceful fallback to the DOM renderer on context loss.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    terminal.loadAddon(webgl);
  } catch {
    // DOM renderer is fine.
  }

  const runtime: TerminalRuntime = {
    terminal,
    fit,
    wrapper,
    lastCols: terminal.cols,
    lastRows: terminal.rows,
    dispose: () => {},
  };

  terminal.onData((data) => cb.onUserInput(data));

  // Debounced fit + resize-notify driven by the wrapper's size.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const doFit = () => {
    if (wrapper.clientWidth === 0 || wrapper.clientHeight === 0) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    if (terminal.cols !== runtime.lastCols || terminal.rows !== runtime.lastRows) {
      runtime.lastCols = terminal.cols;
      runtime.lastRows = terminal.rows;
      cb.onResize(terminal.cols, terminal.rows);
    }
  };
  const ro = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(doFit, RESIZE_DEBOUNCE_MS);
  });
  ro.observe(wrapper);

  runtime.dispose = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    ro.disconnect();
    terminal.dispose();
  };

  return runtime;
}

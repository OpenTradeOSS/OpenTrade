import { TERM_WS_CLOSE } from "@shared/terminal-ws";
import { useTerminalStore } from "../../stores/terminal";
import { getImperativeClient } from "../trpc";
import { createRuntime, type TerminalRuntime } from "./runtime";
import { connectTerminalWs, type TerminalTransport } from "./ws-transport";

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 250;
const RECONNECT_CAP_MS = 5000;

/**
 * Viewport-model terminal controller. ONE xterm runtime is reused across
 * agents; switching agents tears down the old WebSocket, resets the screen, and
 * reattaches the focused agent with ring-buffer replay. There is no per-agent
 * terminal kept alive off-screen (the old "parking registry"): the daemon's
 * ring buffer is the scrollback source of truth, so only the focused agent
 * streams.
 *
 * An `epoch` counter guards against a slow/old WebSocket's late callbacks
 * writing into — or changing the liveness of — a newer agent's view.
 */
class SessionController {
  private runtime: TerminalRuntime | null = null;
  private transport: TerminalTransport | null = null;
  private currentAgentId: string | null = null;
  private epoch = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Lazily create the single runtime; its input/resize route to the live socket. */
  private ensureRuntime(): TerminalRuntime {
    if (this.runtime) return this.runtime;
    this.runtime = createRuntime({
      onUserInput: (data) => this.transport?.sendInput(data),
      onResize: (cols, rows) => this.transport?.sendResize(cols, rows),
    });
    return this.runtime;
  }

  /** Mount the terminal DOM into the visible pane container and fit it. */
  mount(container: HTMLElement) {
    const rt = this.ensureRuntime();
    container.appendChild(rt.wrapper);
    requestAnimationFrame(() => {
      try {
        rt.fit.fit();
        rt.terminal.focus();
      } catch {
        // not visible yet
      }
    });
  }

  /** Show an agent's terminal (no-op if it's already the live one). */
  attach(agentId: string) {
    if (this.currentAgentId === agentId && this.transport) return;
    this.startSession(agentId, "auto");
  }

  /** Restart a dead session with `claude --resume`, then reconnect. */
  resume(agentId: string) {
    this.startSession(agentId, "resume");
  }

  /**
   * Reattach the focused agent after the host transparently respawned its
   * session (auto-respawn). The PTY is already alive, so a plain attach picks
   * up the fresh stream + replay — and `attach` guarantees exactly that: if the
   * respawned PTY has ALREADY died, the host reports dead instead of spawning
   * yet another launch (which resumed the stored id and looped the respawn).
   * Ignored if a different agent is now focused.
   */
  reconnect(agentId: string) {
    if (this.currentAgentId !== agentId) return;
    this.startSession(agentId, "attach");
  }

  /** Stop showing any agent (e.g. selection cleared). PTYs keep running. */
  detach() {
    this.epoch++;
    this.currentAgentId = null;
    this.clearReconnect();
    this.teardownTransport();
  }

  private startSession(agentId: string, intent: "auto" | "resume" | "attach") {
    const myEpoch = ++this.epoch;
    this.currentAgentId = agentId;
    this.clearReconnect();
    this.reconnectAttempts = 0;
    this.teardownTransport();
    this.runtime?.terminal.reset(); // clear before replay repaints onto a fresh grid
    void this.connect(agentId, myEpoch, intent);
  }

  private async connect(agentId: string, myEpoch: number, intent: "auto" | "resume" | "attach") {
    if (myEpoch !== this.epoch) return;
    this.setLiveness(agentId, "connecting");
    try {
      const client = getImperativeClient();
      // Fit to the real pane width BEFORE spawning, so the PTY starts at the
      // displayed width. `mount()` fits on a rAF that may not have fired yet when
      // a freshly-selected agent connects; without this the PTY would spawn at the
      // default 120 cols and its startup output would mis-wrap in a narrower xterm.
      try {
        this.runtime?.fit.fit();
      } catch {
        // pane not laid out yet — fall back to the runtime's current dims
      }
      const cols = this.runtime?.terminal.cols;
      const rows = this.runtime?.terminal.rows;
      // tRPC-first: ensure the session exists before opening the data socket.
      const { alive } = await client.terminal.openOrAttach.mutate({ agentId, cols, rows, intent });
      if (myEpoch !== this.epoch) return;
      // An `attach` found no live PTY (the respawned session died before we got
      // here). `startSession` reset the screen, so repaint the end-state banner
      // rather than connecting a socket to nothing.
      if (!alive && intent === "attach") {
        this.setLiveness(agentId, "dead");
        this.runtime?.terminal.write("\r\n\x1b[2m[session ended — Resume to continue]\x1b[0m\r\n");
        return;
      }
      const { url } = await client.terminal.wsEndpoint.query({ agentId });
      if (myEpoch !== this.epoch) return;
      this.openSocket(agentId, url, myEpoch, intent);
    } catch {
      if (myEpoch !== this.epoch) return;
      this.scheduleReconnect(agentId, myEpoch, intent);
    }
  }

  private openSocket(
    agentId: string,
    url: string,
    myEpoch: number,
    intent: "auto" | "resume" | "attach",
  ) {
    const runtime = this.runtime;
    if (!runtime) return;
    this.transport = connectTerminalWs(url, {
      onOutput: (data) => {
        if (myEpoch === this.epoch) runtime.terminal.write(data);
      },
      onHello: () => {
        if (myEpoch !== this.epoch) return;
        this.setLiveness(agentId, "live");
        this.reconnectAttempts = 0;
        // The replay snapshot was rendered at the PTY's previous dims; push our
        // current fit so Claude redraws (SIGWINCH) and any mis-wrap self-heals.
        this.transport?.sendResize(runtime.terminal.cols, runtime.terminal.rows);
      },
      onExit: () => {
        if (myEpoch !== this.epoch) return;
        this.setLiveness(agentId, "dead");
        runtime.terminal.write("\r\n\x1b[2m[session ended — Resume to continue]\x1b[0m\r\n");
      },
      onClose: (code) => {
        if (myEpoch !== this.epoch) return;
        this.transport = null;
        this.handleClose(agentId, code, myEpoch, intent);
      },
    });
  }

  private handleClose(
    agentId: string,
    code: number,
    myEpoch: number,
    intent: "auto" | "resume" | "attach",
  ) {
    // 1000: clean close right after an exit frame — onExit already marked dead.
    if (code === 1000) return;
    // Session gone on the host (daemon restarted): dead, Resume re-establishes.
    if (code === TERM_WS_CLOSE.NOT_FOUND) {
      this.setLiveness(agentId, "dead");
      return;
    }
    // 4408 (backpressure valve) or 1006 (abnormal, e.g. daemon crash): the
    // session likely still lives — reconnect with replay to catch up / recover.
    this.scheduleReconnect(agentId, myEpoch, intent);
  }

  /** Retries carry the ORIGINAL intent: an `attach` lineage must stay spawn-less
   *  across transient failures, or a retry would relaunch the dead session as a
   *  resume — the reattach leg of the respawn cascade, reopened by a hiccup. */
  private scheduleReconnect(
    agentId: string,
    myEpoch: number,
    intent: "auto" | "resume" | "attach",
  ) {
    if (myEpoch !== this.epoch) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setLiveness(agentId, "dead");
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_CAP_MS);
    this.reconnectAttempts++;
    this.setLiveness(agentId, "connecting");
    this.reconnectTimer = setTimeout(() => {
      if (myEpoch === this.epoch) void this.connect(agentId, myEpoch, intent);
    }, delay);
  }

  private teardownTransport() {
    this.transport?.close();
    this.transport = null;
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setLiveness(agentId: string, value: "connecting" | "live" | "dead") {
    useTerminalStore.getState().setLiveness(agentId, value);
  }
}

export const terminalController = new SessionController();

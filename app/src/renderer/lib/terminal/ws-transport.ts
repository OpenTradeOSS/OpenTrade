import type { TermWsServerMsg } from "@shared/terminal-ws";

export interface TerminalWsHandlers {
  /** Raw PTY output bytes (binary frame) → xterm.write. */
  onOutput: (data: Uint8Array) => void;
  /** Server hello (handshake ok). */
  onHello: (protocol: number) => void;
  /** Session exited (control frame). */
  onExit: (code: number | null, signal: number | null) => void;
  /** Socket closed — `code` is the WebSocket close code. */
  onClose: (code: number) => void;
}

export interface TerminalTransport {
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  close: () => void;
}

/**
 * One terminal's WebSocket connection. Deliberately dumb and URL-agnostic: it
 * opens whatever `url` it's given (ws:// local daemon today, wss:// cloud host
 * later) and never inspects host/port/token — the auth scheme can change
 * server-side without touching this code. Reconnect/liveness policy lives in
 * the session controller, not here.
 */
export function connectTerminalWs(url: string, handlers: TerminalWsHandlers): TerminalTransport {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let msg: TermWsServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "hello") handlers.onHello(msg.protocol);
      else if (msg.type === "exit") handlers.onExit(msg.code, msg.signal);
      return;
    }
    handlers.onOutput(new Uint8Array(ev.data as ArrayBuffer));
  };

  ws.onclose = (ev) => handlers.onClose(ev.code);
  // onerror is followed by onclose; let the controller react to the close code.

  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  return {
    sendInput: (data) => send({ type: "input", data }),
    sendResize: (cols, rows) => send({ type: "resize", cols, rows }),
    close: () => {
      // Drop handlers first so an in-flight close doesn't reach the controller
      // after it has moved on (belt-and-braces alongside the epoch guard).
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closing
      }
    },
  };
}

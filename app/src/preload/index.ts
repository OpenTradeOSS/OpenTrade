import { SHELL_IPC } from "@shared/shell";
import { UPDATER_IPC, type UpdaterState } from "@shared/updater";
import { contextBridge, ipcRenderer } from "electron";

/**
 * Expose the backend host endpoint to the renderer. The launcher passes the
 * tRPC port + token via `additionalArguments` (see window.ts); the renderer's
 * tRPC client (httpBatchLink + wsLink) reads them off `window.__opentradeHost`.
 * Replaces the old trpc-electron IPC bridge now that services live in the host.
 */
function arg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("__opentradeHost", {
  trpcPort: Number(arg("opentrade-trpc-port")) || 0,
  token: arg("opentrade-token"),
});

/**
 * App-updater bridge to the MAIN process. Auto-update can't live in the host
 * (electron-updater needs Electron's `app` + a packaged build), so unlike the rest
 * of the app it's reached over ipcRenderer rather than tRPC. See main/updater.ts.
 */
contextBridge.exposeInMainWorld("__opentradeUpdater", {
  check: (): Promise<UpdaterState> => ipcRenderer.invoke(UPDATER_IPC.check),
  getState: (): Promise<UpdaterState> => ipcRenderer.invoke(UPDATER_IPC.getState),
  install: (): Promise<void> => ipcRenderer.invoke(UPDATER_IPC.install),
  /** Subscribe to pushed state changes; returns an unsubscribe fn. */
  subscribe: (cb: (state: UpdaterState) => void): (() => void) => {
    const listener = (_e: unknown, s: UpdaterState) => cb(s);
    ipcRenderer.on(UPDATER_IPC.state, listener);
    return () => ipcRenderer.removeListener(UPDATER_IPC.state, listener);
  },
});

/**
 * Shell bridge from the MAIN process (desktop status item, §12.6): lets the launcher steer
 * the renderer — today, "select this agent" after a tray-menu click. See shared/shell.ts.
 */
contextBridge.exposeInMainWorld("__opentradeShell", {
  /** The agent selection requested before this renderer mounted, if any (consumed). */
  takePendingAgent: (): Promise<string | null> => ipcRenderer.invoke(SHELL_IPC.takePendingAgent),
  /** Subscribe to pushed "select agent" requests; returns an unsubscribe fn. */
  onSelectAgent: (cb: (agentId: string) => void): (() => void) => {
    const listener = (_e: unknown, agentId: string) => cb(agentId);
    ipcRenderer.on(SHELL_IPC.selectAgent, listener);
    return () => ipcRenderer.removeListener(SHELL_IPC.selectAgent, listener);
  },
  /** Full quit: stop the backend host, then exit the launcher (Settings → General). */
  quitCompletely: (): Promise<void> => ipcRenderer.invoke(SHELL_IPC.quitCompletely),
});

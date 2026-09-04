// App updates for the packaged macOS and Windows apps, via electron-updater against GitHub
// Releases (publish config in electron-builder.yml bakes app-update.yml into the
// build, which electron-updater reads — no feed URL needed here).
//
// POLICY — the user is always in charge. We check on boot + every 4h, but do NOT
// auto-download and do NOT install-on-quit. When a newer version is found the status
// goes to `available` and the sidebar shows an "Update Available" button (see
// UpdateButton) — Settings → About mirrors it. Clicking it calls `install()`:
// download the update (if not already) and relaunch immediately into it. Nothing is
// downloaded or installed without an explicit click.
//
// OpenTrade-specific wrinkle: the backend host is a DETACHED process that survives
// the GUI quitting. After an update swaps the .app and the app relaunches, the new
// launcher's `ensureHost` already refuses to adopt a version-mismatched host and
// SIGTERMs + respawns a fresh one (see host/manifest.ts). That version-aware
// adoption is the ONLY thing that retires the old host, and it runs at the right
// moment: on relaunch (which `install()` forces), not while the GUI is still live.
// We deliberately do NOT SIGTERM the host on download — that killed the backend out
// from under a running session and was redundant with the relaunch-time check.
//
// The renderer reaches all of this over a thin IPC bridge (`window.__opentradeUpdater`,
// see preload). Tracking live status (checking / available / downloading / error)
// also makes silent check failures — e.g. a release published with no
// `latest-mac.yml` asset — visible instead of dying in a console log nobody reads.

import { UPDATER_IPC, type UpdaterState } from "@shared/updater";
import { app, BrowserWindow, ipcMain } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4h

interface UpdaterHooks {
  /** Telemetry hook — the user accepted and the update finished downloading. */
  onDownloaded?: (version: string) => void;
  /** Telemetry hook — an update check/download failed (electron-updater `error`
   *  event). Routed to the host's funnel as a sanitized `app_error` (subsystem
   *  "updater"); the message stays local (only the class name + frames are sent). */
  onError?: (err: unknown) => void;
  /** Display hook — routed through the launcher's gated notification helper so the
   *  "App updates" toggle applies (§12.4). Fires when an update becomes available.
   *  Returns whether a banner was actually shown (false if suppressed by the toggle
   *  or because the window was focused) — the caller only dedupes on a real show. */
  showNotification?: (title: string, body: string) => boolean;
  /** Called immediately before `quitAndInstall()` relaunches the app. The launcher uses
   *  it to lift its ⌘Q→menu-bar intercept (§12.6) so the updater's quit isn't swallowed. */
  onWillRelaunch?: () => void;
}

let hooks: UpdaterHooks = {};
let wired = false;
let booted = false;
let checking = false;
/** Set when the user accepts: install (relaunch) as soon as the download completes. */
let installOnDownloaded = false;
/** The version we last *displayed* a notification for, so the 4h re-check doesn't re-notify. */
let notifiedVersion: string | undefined;

let state: UpdaterState = {
  status: "idle",
  currentVersion: app.getVersion(),
};

/** Merge a state patch and push it to every open renderer. */
function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(UPDATER_IPC.state, state);
  }
}

/** Attach the electron-updater event listeners exactly once. */
function wireEvents(): void {
  if (wired) return;
  wired = true;

  // User-in-charge: never download or install without an explicit accept.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Differential downloads are flaky on macOS zip updates; retain efficient
  // blockmap downloads for the Windows NSIS updater.
  autoUpdater.disableDifferentialDownload = process.platform === "darwin";

  autoUpdater.on("checking-for-update", () => {
    checking = true;
    setState({ status: "checking", error: undefined });
  });

  autoUpdater.on("update-available", (info) => {
    // autoDownload is off, so this does NOT start a download — we just offer it.
    checking = false;
    setState({ status: "available", version: info.version, checkedAt: Date.now() });
    // Only dedupe once a banner was actually displayed: if it was suppressed because
    // the window was focused, a later background re-check should still get the chance.
    if (notifiedVersion !== info.version) {
      const shown = hooks.showNotification?.(
        "OpenTrade update available",
        `Version ${info.version} is available. Open OpenTrade to update.`,
      );
      if (shown) notifiedVersion = info.version;
    }
  });

  autoUpdater.on("update-not-available", () => {
    checking = false;
    setState({ status: "up-to-date", version: undefined, checkedAt: Date.now() });
  });

  autoUpdater.on("download-progress", (p) => {
    setState({ status: "downloading", progressPercent: Math.round(p.percent) });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setState({ status: "downloaded", version: info.version, checkedAt: Date.now() });
    hooks.onDownloaded?.(info.version);
    // The download only ever runs because the user accepted, so relaunch straight
    // into it. On macOS quitAndInstall() ignores its args and the relaunch comes from
    // electron-updater's autoRunAppAfterInstall (default true); the new launcher's
    // version-aware ensureHost then retires the stale host.
    if (installOnDownloaded) {
      installOnDownloaded = false;
      hooks.onWillRelaunch?.();
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => {
    checking = false;
    installOnDownloaded = false;
    console.error("[updater]", err);
    hooks.onError?.(err);
    setState({ status: "error", error: errorMessage(err), checkedAt: Date.now() });
  });
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // A release published without a `latest-mac.yml` asset surfaces as a feed error —
  // translate it into something actionable. Match only feed-specific messages (not a
  // bare "404", which can also be a missing zip mid-download).
  if (/latest(?:-mac)?\.yml|Cannot parse releases feed|Unable to find latest version/i.test(msg)) {
    const feed = process.platform === "darwin" ? "latest-mac.yml" : "latest.yml";
    return `No update feed found on the latest release (missing ${feed}). The release may still be building.`;
  }
  return msg;
}

/**
 * Force a check now (the Settings → About button, and the boot/interval checks).
 * Safe to call in dev — it just reports `unsupported` rather than throwing. No-op
 * while a check is already running or an update is downloading/staged, so the 4h
 * timer can't clobber an in-flight download's state.
 */
export function checkForUpdatesNow(): UpdaterState {
  if (!app.isPackaged) {
    setState({ status: "unsupported", checkedAt: Date.now() });
    return state;
  }
  if (checking || state.status === "downloading" || state.status === "downloaded") return state;
  checking = true;
  setState({ status: "checking", error: undefined });
  autoUpdater.checkForUpdates().catch((err) => {
    // The `error` event usually fires too, but guard the promise rejection so a
    // failed check always lands in a terminal state.
    checking = false;
    console.error("[updater] check failed", err);
    setState({ status: "error", error: errorMessage(err), checkedAt: Date.now() });
  });
  return state;
}

/**
 * Accept the available update: download it (if not already) and relaunch
 * immediately. No-op unless an update is actually available/downloaded.
 */
export function installNow(): void {
  if (!app.isPackaged) return;
  if (state.status === "downloaded") {
    hooks.onWillRelaunch?.();
    autoUpdater.quitAndInstall();
    return;
  }
  if (state.status !== "available") return;
  installOnDownloaded = true;
  setState({ status: "downloading", progressPercent: 0 });
  autoUpdater.downloadUpdate().catch((err) => {
    installOnDownloaded = false;
    console.error("[updater] download failed", err);
    setState({ status: "error", error: errorMessage(err), checkedAt: Date.now() });
  });
}

/**
 * Wire the updater: register the renderer IPC bridge (always, so the button works
 * and can report `unsupported` in dev) and, in a packaged build, run the boot check
 * plus the recurring 4h timer.
 */
export function initAutoUpdate(_win: BrowserWindow, h: UpdaterHooks = {}): void {
  hooks = h;

  // Register the IPC bridge unconditionally so Settings → About is functional even
  // in dev (where it reports `unsupported`). Idempotent across re-init.
  ipcMain.removeHandler(UPDATER_IPC.check);
  ipcMain.removeHandler(UPDATER_IPC.getState);
  ipcMain.removeHandler(UPDATER_IPC.install);
  ipcMain.handle(UPDATER_IPC.check, () => checkForUpdatesNow());
  ipcMain.handle(UPDATER_IPC.getState, () => state);
  ipcMain.handle(UPDATER_IPC.install, () => installNow());

  // electron-updater requires a packaged app with a baked app-update.yml.
  if (!app.isPackaged) {
    setState({ status: "unsupported" });
    return;
  }

  wireEvents();

  // Boot check + recurring timer once per process, even if init runs again (e.g. a
  // window recreation), so we never stack duplicate intervals.
  if (booted) return;
  booted = true;
  checkForUpdatesNow();
  setInterval(() => checkForUpdatesNow(), CHECK_INTERVAL_MS);
}

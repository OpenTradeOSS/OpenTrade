/**
 * Wire contract for the app-updater bridge between the renderer and the Electron
 * MAIN process. Unlike the rest of the app's state (which lives in the backend
 * host and is reached over tRPC), auto-update is inherently a main-process concern:
 * electron-updater needs Electron's `app` and a packaged build, neither of which
 * exists in the headless host. So the renderer reaches it over a thin
 * `ipcRenderer.invoke` / `webContents.send` bridge exposed on `window.__opentradeUpdater`.
 *
 * Policy: the user is always in charge of updating. We check on boot + every 4h but
 * NEVER auto-download or install-on-quit. When a newer version is found the status
 * goes to `available`; the renderer shows a prompt; only an explicit `install`
 * downloads (if needed) and restarts immediately.
 */

/** The lifecycle of an update check/download, surfaced in the sidebar UpdateButton + Settings → About. */
export type UpdaterStatus =
  | "idle" // no check has run yet this session
  | "checking" // a check is in flight
  | "available" // a newer version exists, awaiting the user's decision (NOT downloading)
  | "downloading" // the user accepted; the update is downloading
  | "downloaded" // download complete; the app is about to relaunch into it
  | "up-to-date" // check completed, already on the latest version
  | "error" // last check/download failed
  | "unsupported"; // not a packaged build (dev) — updates can't run

export interface UpdaterState {
  status: UpdaterStatus;
  /** The running app version (always known). */
  currentVersion: string;
  /** The version found/downloading/ready (for available/downloading/downloaded). */
  version?: string;
  /** 0–100 while downloading. */
  progressPercent?: number;
  /** Human-readable failure for the `error` status. */
  error?: string;
  /** epoch ms of the last completed check (success or error). */
  checkedAt?: number;
}

/** Whether a version string carries a semver prerelease component (`0.2.8-beta.1`).
 *  The host uses it to enroll a freshly installed beta build in the beta channel; the
 *  Settings switch uses it to explain what "off" means on a beta build. */
export function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}

/** IPC channel names — kept here so main, preload, and renderer can't drift. */
export const UPDATER_IPC = {
  /** invoke → force a check now; resolves to the resulting UpdaterState. */
  check: "updater:check",
  /** invoke → read the current UpdaterState without triggering a check. */
  getState: "updater:getState",
  /** invoke → accept the available update: download (if needed) then relaunch immediately. */
  install: "updater:install",
  /** main → renderer push whenever the state changes. */
  state: "updater:state",
} as const;

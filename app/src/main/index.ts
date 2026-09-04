import { join } from "node:path";
import type { Agent } from "@shared/agent";
import { errorCodeOf, errorNameOf, sanitizeStack } from "@shared/analytics";
import type { HostNotification, NotificationKind, RecentNotification } from "@shared/notify";
import { type AppSettings, DEFAULT_SETTINGS } from "@shared/settings";
import { SHELL_IPC } from "@shared/shell";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { app, BrowserWindow, ipcMain, Notification, powerMonitor } from "electron";
import superjson from "superjson";
import { WebSocket as NodeWebSocket } from "ws";
import { OPENTRADE_HOME } from "./db/client";
import {
  ensureHost,
  type HostManifest,
  isAlive,
  readManifest,
  terminateHost,
} from "./host/manifest";
import { AppTray } from "./tray";
import type { AppRouter } from "./trpc/routers";
import { initAutoUpdate } from "./updater";
import { createMainWindow } from "./window";

let mainWindow: BrowserWindow | null = null;
let relayClient: ReturnType<typeof createWSClient> | null = null;
let relayTrpc: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;
/** The adopted host, kept so a notification/tray click can recreate a closed window. */
let currentHost: HostManifest | null = null;
/** Live AppSettings mirror driven by `settings.onChanged`; gates notification display
 *  and the menu bar item. Seeded with defaults (all on) so both work before the first
 *  push arrives. */
let liveSettings: AppSettings = DEFAULT_SETTINGS;
/** Set when a *real* quit is underway (tray Quit, updater relaunch, OS shutdown/logout).
 *  While false and the menu bar item is on, ⌘Q retreats to the menu bar instead (§12.6). */
let quitting = false;
/** Whether the quit in flight is the UPDATER's relaunch — only that quit may be rolled
 *  back by the updater's `onError` (a failed quitAndInstall); see the handler. */
let updaterRelaunching = false;
/** Agent the tray asked the renderer to select, with the time of the click. Consumed by
 *  the renderer's mount-time pull; cleared when the window closes. The pull only exists
 *  for a renderer that mounts *because of* that click, so it expires — otherwise a much
 *  later renderer reload (a crash auto-reload, a dev refresh) would pull a stale id and
 *  jump the view for no reason. */
let pendingSelect: { agentId: string; at: number } | null = null;
const PENDING_SELECT_TTL_MS = 30_000;

/** AppSettings toggle backing each notification kind. */
const NOTIFY_TOGGLE: Record<NotificationKind, keyof AppSettings> = {
  wake: "notifyWakes",
  order: "notifyOrders",
  approval: "notifyApprovals",
  restricted: "notifyRestricted",
  update: "notifyUpdates",
};

/** The macOS menu bar / Windows system tray keeps the launcher reachable while its
 *  window is closed. Toggled live by the `showInMenuBar` setting. Off when the host
 *  never came up: there's nothing to monitor, and the BackendFailed screen tells the user
 *  to quit + reopen — ⌘Q must really quit for that recovery to work. */
function menuBarEnabled(): boolean {
  return (
    (process.platform === "darwin" || process.platform === "win32") &&
    liveSettings.showInMenuBar &&
    (currentHost?.trpcPort ?? 0) > 0
  );
}

/** True only when a live (non-destroyed) window exists and is focused. */
function windowFocused(): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFocused();
}

/**
 * Create the main window and wire everything that is per-*window* (not per-launcher):
 * the focus/blur → broker cadence relay and the `closed` bookkeeping. Every creation
 * site goes through here — boot, dock `activate`, notification click, tray click — so a
 * recreated window behaves exactly like the first one.
 */
function openWindow(host: HostManifest): BrowserWindow {
  const win = createMainWindow({ trpcPort: host.trpcPort, token: host.token });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
      // An undelivered tray selection is moot once its window is gone, and a delivered
      // one must not leak into the next mount's pull.
      pendingSelect = null;
    }
  });
  // Relay window focus to the host so it polls the broker at the fast cadence only
  // while the user is watching (the host defaults to the blurred cadence). The
  // window opens focused, so assert that once, then track focus/blur.
  const setFocused = (focused: boolean) =>
    relayTrpc?.broker.setFocused.mutate({ focused }).catch(() => {});
  setFocused(true);
  win.on("focus", () => setFocused(true));
  win.on("blur", () => setFocused(false));
  return win;
}

/** Restore/show/focus the window, recreating it if it was closed — on macOS the app
 *  outlives its window, so a click on a wake notification or the tray must be able to
 *  reopen it. Also brings the dock icon back if we had retreated to the menu bar. */
function focusMainWindow(): void {
  // Menu-bar mode hides the dock icon; a visible window wants it back (and the app
  // has to be a regular app again to reliably come to the front).
  void app.dock?.show();
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!currentHost) return;
    const win = openWindow(currentHost);
    win.once("ready-to-show", () => app.focus({ steal: true }));
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
}

/** Open the window *and* select an agent — a tray-menu click on an agent row (§12.6
 *  shell bridge). Push + pull: the push reaches a mounted renderer; a still-loading
 *  renderer (or one this call just created) drops it and pulls `pendingSelectAgent` on
 *  mount instead. A mounted renderer may get both — its apply is idempotent. */
function openAgent(agentId: string): void {
  pendingSelect = { agentId, at: Date.now() };
  focusMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(SHELL_IPC.selectAgent, agentId);
  }
}

/** Close the window(s): the launcher lives on as the menu bar item only. What ⌘Q /
 *  dock-Quit do while `showInMenuBar` is on. The dock icon is dropped by the
 *  `window-all-closed` handler this triggers — the same path the red button takes. */
function retreatToMenuBar(): void {
  for (const w of BrowserWindow.getAllWindows()) w.close();
}

/** Really exit the launcher (the host is detached and keeps running regardless). */
function quitForReal(): void {
  quitting = true;
  app.quit();
}

/**
 * Full quit: stop the backend host, then exit the launcher — nothing keeps running.
 * One SIGTERM tears down the whole tree (the host's graceful handler kills in-flight
 * headless wakes + clears their spawn markers so no agent gets marked broken, stops
 * codex app-servers and PTYs, and clears the manifest); the next launch respawns a
 * fresh host via `ensureHost`. Shared by the tray row and the Settings button.
 */
async function quitCompletely(): Promise<void> {
  quitting = true; // set BEFORE the await — a ⌘Q racing the teardown must not retreat
  const host = currentHost;
  // Revalidate the boot-time pid before signalling it: the launcher can sit in the
  // menu bar for days, so the host may have died since and the OS reused the pid —
  // the manifest must still name it AND it must still be alive.
  if (host && host.pid > 0 && readManifest()?.pid === host.pid && isAlive(host.pid)) {
    try {
      await terminateHost(host);
    } catch (err) {
      console.error("[launcher] host termination failed", err);
    }
  }
  quitForReal();
}

/** The status item. Constructed eagerly (cheap; no Tray until `show()`), fed by the
 *  relay below, shown/hidden by `applyMenuBar` as the setting changes. */
const tray = new AppTray({
  openWindow: focusMainWindow,
  openAgent,
  quit: quitForReal,
  quitCompletely: () => void quitCompletely(),
});

/** Reconcile the tray with the live setting. Turning it off while retreated would leave
 *  no way back into the app, so that path also restores the dock icon. */
function applyMenuBar(): void {
  if (menuBarEnabled()) {
    tray.show();
  } else {
    tray.hide();
    void app.dock?.show();
  }
}

/** The single display path for every notification kind: gate on the per-kind toggle,
 *  show the banner, and on click focus the window + fire `notification_clicked`. Safe
 *  to call even when the relay never connected (the updater calls it regardless).
 *  Returns whether a banner was actually shown (false if the toggle is off or the OS
 *  can't display one) — callers that dedupe rely on this. */
function showAppNotification(kind: NotificationKind, title: string, body: string): boolean {
  if (!liveSettings[NOTIFY_TOGGLE[kind]]) return false;
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title, body });
  n.on("click", () => {
    focusMainWindow();
    relayTrpc?.analytics.track
      .mutate({ event: "notification_clicked", props: { kind } })
      .catch(() => {});
  });
  n.show();
  return true;
}

// Key Electron's per-instance state (including the single-instance lock) to this
// home so parallel dev instances with distinct OPENTRADE_HOME don't collide.
app.setPath("userData", join(OPENTRADE_HOME, "electron"));
if (process.platform === "win32") app.setAppUserModelId("ai.exla.opentrade");

if (!app.requestSingleInstanceLock()) {
  // Another OpenTrade GUI is already running for this home — defer to it and exit.
  // (The backend host is separate and keeps running regardless.)
  app.quit();
} else {
  // A second launch (Finder / Spotlight / `open -a`) is how a user reaches a launcher
  // that has retreated to the menu bar and hidden its dock icon — so it must be able
  // to recreate the window, not just focus an existing one.
  app.on("second-instance", () => focusMainWindow());
  app.whenReady().then(main);
}

async function main() {
  // The backend brokers real trades; surface its version to the headless host.
  process.env.OPENTRADE_VERSION = app.getVersion();

  // Adopt a running backend host or spawn one (detached, supervised). This is the
  // only way the GUI reaches state now — services live in the host, not here.
  let host: HostManifest;
  try {
    host = await ensureHost(join(__dirname, "host.js"), app.getVersion());
  } catch (err) {
    console.error("[launcher] backend host unavailable", err);
    // Still open the window, but with a zeroed port. The renderer reads trpcPort===0
    // as "backend failed to start" and shows a dedicated screen (BackendFailed)
    // instead of hanging on a blank screen.
    host = { pid: 0, faucetPort: 0, trpcPort: 0, token: "", startedAt: 0 };
  }
  currentHost = host;

  // Shell bridge (§12.6): a renderer created *by* a tray click pulls the agent it
  // should select once it mounts (the push would have preceded its listener).
  ipcMain.handle(SHELL_IPC.takePendingAgent, () => {
    const pending = pendingSelect;
    pendingSelect = null;
    if (!pending || Date.now() - pending.at > PENDING_SELECT_TTL_MS) return null;
    return pending.agentId;
  });
  // Settings → General "Quit completely": same path as the tray row.
  ipcMain.handle(SHELL_IPC.quitCompletely, () => quitCompletely());

  const win = openWindow(host);

  if (host.trpcPort) wireNotifications(host);
  // The menu bar item first appears from the initial `settings.onChanged` push (sub-
  // second; emit-on-subscribe), NOT eagerly here: seeding from the default-on setting
  // flashed the tray for users who disabled it — and while that flash lasted, ⌘Q
  // retreated to a menu bar they'd turned off instead of quitting.

  // OS shutdown / restart / logout must not be blocked by the ⌘Q intercept: lift it
  // and go. (`powerMonitor` is only usable after `ready`.)
  powerMonitor.on("shutdown", () => quitForReal());

  // App updates against GitHub Releases (no-op in dev / unpackaged). User-in-charge:
  // we check on boot + every 4h but never auto-download or install-on-quit — the
  // renderer prompts and the user accepts, which downloads + relaunches (the new
  // launcher's version-aware ensureHost then retires the stale host). The
  // download-complete event rides the relay client to the host's telemetry funnel;
  // the "available" banner goes through the gated helper so the "App updates" toggle applies.
  initAutoUpdate(win, {
    onDownloaded: (toVersion) =>
      relayTrpc?.analytics.track
        .mutate({ event: "update_downloaded", props: { to_version: toVersion } })
        .catch(() => {}),
    // A failed update check/download rides the same relay to the host funnel as a
    // sanitized `app_error` (subsystem "updater") — class name + bundle frames only,
    // never the message — so update failures are triageable alongside other daemon errors.
    onError: (err) => {
      // A failed `quitAndInstall` means no relaunch is happening after all — undo the
      // flag `onWillRelaunch` set so ⌘Q doesn't permanently quit instead of retreating.
      // Scoped to relaunches the UPDATER initiated: `error` also fires for routine
      // check/download failures, and blindly clearing `quitting` there would flip an
      // unrelated in-flight real quit (quitCompletely's await window, OS shutdown)
      // back into a retreat — during logout, a preventDefault against the OS.
      if (updaterRelaunching) {
        updaterRelaunching = false;
        quitting = false;
      }
      const frames = sanitizeStack(err);
      // electron-updater reports check/download failures as a bare `Error`, so the class
      // name says nothing and a network throw often leaves no frame of ours. `err.code`
      // (or its `cause`'s, for an undici `fetch failed`) is the only token that separates
      // "this machine can't reach the feed" from a server-side or signing failure.
      const code = errorCodeOf(err);
      relayTrpc?.analytics.track
        .mutate({
          event: "app_error",
          props: {
            subsystem: "updater",
            error_name: errorNameOf(err),
            ...(code ? { error_code: code } : {}),
            source: "caught",
            ...(frames.length ? { frames } : {}),
          },
        })
        .catch(() => {});
    },
    // The in-app "Update Available" button is the indicator when the window is open;
    // only fall back to an OS notification when the user is away, so we don't
    // double-notify on boot. Returns whether it displayed so the updater dedupes on a
    // real show (a focus-suppressed one leaves the next background re-check free to fire).
    showNotification: (title, body) =>
      windowFocused() ? false : showAppNotification("update", title, body),
    // The relaunch is a real quit — don't let the menu-bar intercept swallow it.
    onWillRelaunch: () => {
      updaterRelaunching = true;
      quitting = true;
    },
  });

  // Dock click with no window → recreate it (through the same path as every other
  // reopen, so a hidden dock icon comes back too).
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) focusMainWindow();
  });
}

// macOS/Windows: closing the window does not quit the app while the status item is
// enabled. The backend host is detached
// and survives regardless, so agent sessions keep running with the GUI closed.
// With the menu bar item on, "no window" also means "no dock icon" — the status
// item *is* the app until the user opens it again (§12.6).
app.on("window-all-closed", () => {
  // Same guard as the quit intercept: only go dockless when there's a status item
  // left to reach the app through.
  if (tray.visible) {
    app.dock?.hide();
    return;
  }
  app.quit();
});

// A signal is an explicit "exit" from outside — dev.sh, `kill`, the terminal's ^C, a
// logout Electron didn't translate — and must never be swallowed into the menu-bar
// retreat. Electron's default signal handling funnels into `before-quit` (where the
// intercept below would catch it and orphan the tray); registering our own listeners
// replaces that path so a signal always really exits.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, quitForReal);

app.on("before-quit", (e) => {
  // ⌘Q / dock-Quit with the menu bar item showing: don't exit — retreat to the menu bar
  // so agent status + notifications keep flowing while the app is "closed". A real exit
  // comes from the tray's Quit, the updater's relaunch, OS shutdown, or a signal
  // (`quitting`). The guard is the tray's ACTUAL visibility, not just the setting: a
  // retreat with no status item to retreat *to* would leave no window, no dock icon and
  // no way back in. (They can diverge — e.g. the host is up, so the setting says yes,
  // but the relay never connected and `applyMenuBar` never ran.)
  if (tray.visible && !quitting) {
    e.preventDefault();
    retreatToMenuBar();
    // Still drop the broker to the blurred cadence: the user is gone even though the
    // process isn't. (Closing the window emits `blur` too, but that's a Chromium
    // detail, not a contract.)
    relayTrpc?.broker.setFocused.mutate({ focused: false }).catch(() => {});
    return;
  }
  // GUI going away → drop the broker to the blurred poll cadence. We do NOT tear
  // down PTYs here: the host's gui-presence detector already fires on the renderer
  // WS dropping (covers Cmd-Q, window-close, and crash uniformly) and tears down
  // every interactive PTY on `gui:gone` (§12.2). Headless `-p` scheduled runs are
  // PTY-independent, so they run to completion regardless of the GUI.
  relayTrpc?.broker.setFocused.mutate({ focused: false }).catch(() => {});
  relayClient?.close();
});

/**
 * Notification relay. All app state lives in the backend host, so macOS
 * notifications, the dock badge, the menu bar item, and the focus relay are driven
 * by a small tRPC-over-WS client — out of the data path. The host formats
 * notifications (`notifications.onNotify`); this launcher gates them (per-kind
 * toggle, per-agent mute, window focus for wakes) and displays them. The approval
 * badge/flash stay unconditional — only the approval *banner* is gated (§12.4). The
 * same streams feed the tray (§12.6), ungated: it's a monitor, not an interruption.
 */
function wireNotifications(host: HostManifest) {
  const wsClient = createWSClient({
    // Tag this connection `&client=relay` so the host's gui-presence detector
    // excludes it — only true renderer connections count as "GUI present" (§12.2).
    // That's also what lets a menu-bar-only launcher leave the host in headless mode.
    url: `ws://127.0.0.1:${host.trpcPort}?token=${encodeURIComponent(host.token)}&client=relay`,
    // Electron main is a Node context; supply a WebSocket implementation.
    WebSocket: NodeWebSocket as unknown as typeof WebSocket,
  });
  relayClient = wsClient;
  const client = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient, transformer: superjson })],
  });
  relayTrpc = client;

  // The boot window opens focused (its own focus/blur handlers were bound before the
  // relay existed, so assert the initial state here once).
  client.broker.setFocused.mutate({ focused: true }).catch(() => {});

  // Keep the notification gate + menu bar toggle live. `settings.onChanged` pushes the
  // current settings immediately on (re)connect, so this both seeds and refreshes the
  // cache and self-heals across a relay reconnect — no separate `get` query needed.
  client.settings.onChanged.subscribe(undefined, {
    onData: (s: AppSettings) => {
      liveSettings = s;
      applyMenuBar();
    },
  });

  // Agent list + statuses → the tray's per-agent rows (pushed on every change).
  client.agents.onChanged.subscribe(undefined, {
    onData: (list: Agent[]) => tray.setAgents(list),
  });

  // Seeded by `approvals.onChanged` below — it emits on subscribe, like the other
  // subscriptions, so no eager call is needed here.
  const updateBadge = async () => {
    try {
      const n = await client.approvals.pendingCount.query();
      app.dock?.setBadge(n > 0 ? String(n) : "");
      tray.setPendingCount(n);
    } catch {
      // host briefly unreachable — leave the badge as-is
    }
  };

  // Approval alerts: the dock badge + frame flash + window focus are unconditional
  // (the user asked for an approval; they need to see it). Only the banner is gated,
  // and that happens on the `notify` stream below. With no window (menu-bar mode) the
  // tray title carries the count instead — we deliberately don't pop the window open.
  client.approvals.onPending.subscribe(undefined, {
    onData: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isFocused()) mainWindow.flashFrame(true);
        mainWindow.focus();
      }
      void updateBadge();
    },
  });

  client.approvals.onChanged.subscribe(undefined, {
    onData: () => void updateBadge(),
  });

  // The tray's Recent list, straight from the host's durable ring buffer: the full
  // list on (re)connect and on every change, so it survives a launcher quit and a host
  // restart. Fed pre-gate on the host side — muting a banner shouldn't erase the event
  // from the monitor you deliberately opened.
  client.notifications.onRecent.subscribe(undefined, {
    onData: (list: RecentNotification[]) => tray.setRecent(list),
  });

  // Host-formatted notification banners. The host owns the copy; the launcher gates
  // per-agent mute + (for wakes) window focus, then displays via the shared helper
  // (which applies the per-kind toggle).
  client.notifications.onNotify.subscribe(undefined, {
    onData: (n: HostNotification) => {
      if (n.agentId && liveSettings.notifyMutedAgents.includes(n.agentId)) return;
      // Wakes only interrupt when you're away — you'd see the terminal light up otherwise.
      if (n.kind === "wake" && windowFocused()) return;
      showAppNotification(n.kind, n.title, n.body);
    },
  });
}

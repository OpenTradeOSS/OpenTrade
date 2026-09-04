// OpenTrade backend host entry point.
//
// Spawned by the Electron app as a SEPARATE, DETACHED process (Electron binary
// running as Node, ELECTRON_RUN_AS_NODE=1). This is the persistent "brain": it
// owns the DB, the Robinhood connection, the approval gate, the audit log, and
// each agent's `claude` PTY — so agents keep running (and the gate keeps working)
// with the GUI closed. The app is a thin client that adopts-or-spawns this host
// and talks to it over localhost tRPC-HTTP/WS.
//
// No Electron APIs are available here (app/shell/Notification/safeStorage); the
// service chain is headless-clean and the launcher passes app metadata via env.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createDb, OPENTRADE_HOME } from "../db/client";
import { AgentRegistry } from "../services/agents/registry";
import { analytics } from "../services/analytics";
import { ApprovalService } from "../services/approvals";
import { AuditLog } from "../services/audit";
import { BrokerService } from "../services/broker";
import { RobinhoodAdapter } from "../services/broker/robinhood/client";
import { bus } from "../services/event-bus";
import { registerHarness } from "../services/harness";
import { CODEX_SUBSCRIPTION_AUTH_STRIP, createCodexHarness } from "../services/harness/codex";
import { CodexAppServerManager } from "../services/harness/codex-app-server";
import { buildCodexAnswerer, buildInteractivePushFactory } from "../services/harness/codex-gate";
import { LocalApiServer } from "../services/local-api";
import { derivePort } from "../services/local-api/endpoint";
import { Scheduler } from "../services/scheduler";
import {
  CodexHeadlessStrategy,
  HarnessRoutingHeadlessStrategy,
} from "../services/scheduler/wake/codex-strategy";
import { WakeCoordinator } from "../services/scheduler/wake/coordinator";
import { HeadlessRunStrategy } from "../services/scheduler/wake/headless-strategy";
import { readSpawnMarkers, reconcileSpawnMarkers } from "../services/scheduler/wake/spawn-marker";
import { SettingsService } from "../services/settings";
import { StatusArbiter } from "../services/status/arbiter";
import { TerminalService } from "../services/terminal";
import { buildAgentEnv } from "../services/terminal/env";
import type { Context } from "../trpc/trpc";
import { hostLog } from "./log";
import { clearManifest, writeManifest } from "./manifest";
import { HostTrpcServer } from "./trpc-server";

/**
 * Open a URL in the user's browser headlessly (no Electron shell). Its only caller is
 * the broker's OAuth consent, so a failure is reported under `broker`: without that, a
 * consent whose tab never opened is indistinguishable in telemetry from one the user
 * abandoned (both end in `OAUTH_TIMEOUT`).
 */
function openExternal(url: string): void {
  // "start" is a cmd.exe builtin, not a standalone executable — it must be run
  // via `cmd /c`, with the empty "" arg so `start` doesn't treat the URL as its
  // (quoted) window-title argument.
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(cmd, args, (err) => {
    if (!err) return;
    hostLog.error("openExternal failed", String(err));
    analytics.trackError("broker", err, "caught");
  });
}

async function main() {
  // Name the detached backend so it reads as OpenTrade in `ps`/`top` (it's an
  // ELECTRON_RUN_AS_NODE child of the app binary). See docs/PACKAGING.md.
  process.title = "OpenTrade Host";
  hostLog.info(`host starting (pid ${process.pid}) home=${OPENTRADE_HOME}`);

  const db = createDb();
  const registry = new AgentRegistry(db);
  registry.resetStatusesOnBoot();

  const settings = new SettingsService(db);
  // Single telemetry funnel — wired early so the gui:present / settings:changed
  // listeners are live before the GUI connects. Inert without a build-time key
  // and in dev (unless OPENTRADE_ANALYTICS_DEV=1).
  analytics.init({ settings });
  const arbiter = new StatusArbiter(registry);
  const audit = new AuditLog(db, registry);
  const approvals = new ApprovalService(db, registry, audit, arbiter);
  // Fresh host process → no agent hook is still long-polling, so pending rows
  // really are orphans.
  approvals.expireOrphansOnBoot();
  // A surviving wake marker is positive evidence the previous host exited uncleanly
  // (a clean shutdown clears them) — capture it before reconcile clears the markers.
  const afterCrash = readSpawnMarkers().length > 0;
  // Recover from a crash that orphaned a headless wake mid-run: kill any survivor and
  // mark the agent broken so we never spawn a second writer on its session (E1).
  reconcileSpawnMarkers(registry);

  const adapter = new RobinhoodAdapter({ db, openBrowser: openExternal });
  // `approvals` supplies the order→agent link so order notifications fire only for
  // agent-placed orders (§12.4).
  const broker = new BrokerService(db, adapter, settings, approvals);
  // Reverse link: let a cancel's approval card resolve the target order id against
  // the cached ledger so it shows the real order, not a bare uuid (§6.9).
  approvals.setOrderResolver(
    (orderId) => broker.getAgenticOrdersCached()?.value.find((o) => o.id === orderId) ?? null,
  );

  // Stable endpoint: home-derived faucet port + persisted token, shared by the
  // faucet/gate, the terminal WS, and the tRPC server.
  const token = settings.getOrCreate("local_api_token", () => randomBytes(24).toString("hex"));
  const localApi = new LocalApiServer({
    broker,
    approvals,
    registry,
    arbiter,
    port: derivePort(),
    token,
  });
  await localApi.start();

  // Codex agents run against a per-agent supervised `codex app-server` (the engine
  // the stock TUI in the PTY auto-attaches to). The backend connects episodically —
  // wakes, headless turns, thread creation — and answers approval requests through
  // the same ApprovalService gate as claude's hooks. Server env is fixed at server
  // spawn; a `backgroundAllowApiKey` change applies to the next server (re)start.
  const codexManager = new CodexAppServerManager(
    (agentId) =>
      buildAgentEnv(
        agentId,
        {
          OPENTRADE_PORT: String(localApi.port),
          OPENTRADE_TOKEN: token,
          OPENTRADE_HARNESS: "codex",
        },
        {
          stripEnvKeys: settings.get().backgroundAllowApiKey
            ? []
            : [...CODEX_SUBSCRIPTION_AUTH_STRIP],
        },
      ),
    buildCodexAnswerer(approvals),
  );
  // Codex is constructed here (it needs the manager) and registered into the
  // harness registry, which the rest of the app resolves through `harnessFor`.
  registerHarness(createCodexHarness(codexManager));
  // An archived agent's engine has no reason to keep running.
  bus.onEvent("agent:archived", ({ agentId }) => codexManager.stopServer(agentId));

  // Autonomy: the single wake coordinator. It owns one per-agent queue and drains each
  // wake through its harness's transports — claude: `claude/channel` inject into a live
  // PTY / headless `claude --resume -p` child; codex: a `turn/start` on the agent's
  // app-server for BOTH (the TUI, when attached, renders it live). Built before the
  // TerminalService so the latter can report PTY up/down to it.
  const wake = new WakeCoordinator(
    registry,
    new HarnessRoutingHeadlessStrategy(
      registry,
      // Background runs default to the subscription login (strip the API key) so
      // unattended agents don't silently bill the API; "Allow API key usage" opts out live.
      new HeadlessRunStrategy(registry, localApi, () => !settings.get().backgroundAllowApiKey),
      new CodexHeadlessStrategy(registry, codexManager),
    ),
    {
      // The turn-limit gate + run-duration cap read live, so a Settings change applies
      // to the next wake without a restart.
      turnLimitFeatureEnabled: () => settings.get().headlessTurnLimitEnabled,
      maxHeadlessTurns: () => settings.get().maxHeadlessTurns,
      maxHeadlessRunMs: () => settings.get().maxHeadlessRunMinutes * 60_000,
    },
  );

  const terminal = new TerminalService(
    registry,
    localApi,
    arbiter,
    wake,
    buildInteractivePushFactory(codexManager, registry),
  );
  await terminal.start();

  // Durable scheduler over the coordinator. The scheduler + coordinator are late-bound
  // into the LocalApi so the agent MCP server's /schedules and /wake-stream routes
  // reach them.
  const scheduler = new Scheduler(db, wake, registry, localApi);
  localApi.setScheduler(scheduler);
  localApi.setWake(wake);
  // Let the coordinator pause/resume an agent's crons + monitors as it breaks/recovers.
  wake.setScheduler(scheduler);

  // Reconnect the broker silently if we already have cached tokens.
  if (broker.isAuthorized()) {
    broker.connect().catch((err) => hostLog.error("broker auto-connect failed", String(err)));
  }

  // Arm timers + monitor children after the boot sweep (services are all up).
  scheduler.start();

  const ctx: Context = {
    db,
    registry,
    terminal,
    broker,
    approvals,
    audit,
    settings,
    scheduler,
    wake,
  };
  const trpc = new HostTrpcServer(ctx, token);
  await trpc.listen();

  writeManifest({
    pid: process.pid,
    faucetPort: localApi.port,
    trpcPort: trpc.port,
    token,
    startedAt: Date.now(),
    // App version this host was built from. The launcher refuses to adopt a host
    // whose version differs from its own (post-update the old detached host is
    // still running old code) and respawns a fresh one. See manifest.ensureHost.
    version: process.env.OPENTRADE_VERSION ?? "0.0.0",
  });
  hostLog.info(`host ready: faucet=${localApi.port} trpc=${trpc.port}`);

  // Telemetry lifecycle: the host is up. `app_updated` fires once per version
  // transition (the reliable "an update actually landed" signal for the detached
  // host), tracked via the persisted `last_run_version`.
  analytics.track("host_started", afterCrash ? { after_crash: true } : undefined);
  const runVersion = process.env.OPENTRADE_VERSION ?? "0.0.0";
  const prevVersion = settings.getOrCreate("last_run_version", () => runVersion);
  if (prevVersion !== runVersion) {
    analytics.track("app_updated", { from_version: prevVersion, to_version: runVersion });
    settings.setRaw("last_run_version", runVersion);
  }

  // Heartbeat driving the `system.tick` subscription.
  const tick = setInterval(() => bus.emitEvent("system:tick", { at: Date.now() }), 1000);

  const shutdown = (sig: string) => {
    hostLog.info(`host shutting down (${sig})`);
    clearInterval(tick);
    scheduler.stop();
    // Kill in-flight headless wakes + clear their markers so this clean exit isn't
    // mistaken for a crash on the next boot (which would flip agents to broken).
    wake.stopAll();
    codexManager.stopAll();
    terminal.stop();
    localApi.stop();
    trpc.close();
    // Flush any queued telemetry before exiting (bounded so we can't hang on quit).
    void analytics.shutdown(1500).finally(() => {
      clearManifest();
      process.exit(0);
    });
  };
  // Survive the launching app going away; quit only on explicit signals/reboot.
  process.on("SIGHUP", () => {});
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Last-resort crash telemetry (sanitized: class name + bundle frames only), then
  // flush + exit non-zero on a fatal error; an unhandled rejection is logged only.
  process.on("uncaughtException", (err) => {
    hostLog.error("uncaughtException", String(err));
    analytics.trackError("host", err, "uncaught_exception");
    void analytics.shutdown(1000).finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    hostLog.error("unhandledRejection", String(reason));
    analytics.trackError("host", reason, "unhandled_rejection");
  });
}

main().catch((err) => {
  hostLog.error("host failed to start", String(err));
  process.exit(1);
});

/**
 * The release channel this build was made for, and the on-disk identity that follows
 * from it. Modeled on Zed's channels: every channel is built from `main`, and a
 * channel only changes packaging and identity, never code paths.
 *
 *  - `stable` — OpenTrade.app (`ai.exla.opentrade`). Stable and beta releases are
 *    both this channel; beta is an update-feed opt-in (see `UpdateChannel`).
 *  - `nightly` — OpenTrade Nightly.app (`ai.exla.opentrade.nightly`), built from `main`
 *    every night with experimental features on. It is a separate application: it
 *    runs side by side with OpenTrade and shares nothing with it.
 *
 * Every per-install state keys off the channel's home dir, so the two apps never
 * touch each other's data: the DB and Key Vault, agent folders, the host manifest,
 * the home-derived local API port, Electron's userData and single-instance lock, and
 * the codex per-agent state (`cx/`). Two hosts sharing one home would each fire the
 * same schedules (duplicate orders), and a nightly migration would upgrade the DB
 * out from under stable.
 *
 * The channel is baked in at build time (`OPENTRADE_CHANNEL`, via electron-vite
 * `define`); tests and unbundled runs see `stable`. Dependency-free: imported by the
 * stdio MCP servers as well as the host and renderer.
 */

export type ReleaseChannel = "stable" | "nightly";

declare const __OPENTRADE_CHANNEL__: string | undefined;

export const RELEASE_CHANNEL: ReleaseChannel =
  typeof __OPENTRADE_CHANNEL__ !== "undefined" && __OPENTRADE_CHANNEL__ === "nightly"
    ? "nightly"
    : "stable";

export const IS_NIGHTLY = RELEASE_CHANNEL === "nightly";

/** User-facing app name: window/tray/notification titles. */
export const APP_DISPLAY_NAME = IS_NIGHTLY ? "OpenTrade Nightly" : "OpenTrade";

/** The data home under `~` (overridable at runtime with `OPENTRADE_HOME`). */
export const APP_HOME_DIRNAME = IS_NIGHTLY ? ".opentrade-nightly" : ".opentrade";

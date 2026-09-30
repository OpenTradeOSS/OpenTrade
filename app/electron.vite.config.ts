import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Release channel baked into every bundle (read by @shared/app-identity). The nightly
// workflow builds with OPENTRADE_CHANNEL=nightly; everything else is stable.
const channel = process.env.OPENTRADE_CHANNEL === "nightly" ? "nightly" : "stable";
const define = { __OPENTRADE_CHANNEL__: JSON.stringify(channel) };

export default defineConfig({
  main: {
    // Bundle `ws` and `posthog-node` into the daemon bundle (both pure JS, no
    // native code) rather than externalizing them: a detached
    // ELECTRON_RUN_AS_NODE child resolving a bundled dep avoids the asar/runtime-
    // require fragility that bites native modules. node-pty stays externalized
    // (native, ABI-rebuilt).
    plugins: [externalizeDepsPlugin({ exclude: ["ws", "posthog-node"] })],
    define,
    resolve: {
      alias: {
        "@main": resolve("src/main"),
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      // "hidden": emit sourcemaps but leave no `//# sourceMappingURL` comment in the
      // bundle, so the maps are NOT shipped/referenced in the user build — they're
      // excluded from the app in electron-builder.yml and published as a GitHub Release
      // asset for symbolicating `app_error` frames. See docs/ARCHITECTURE.md §telemetry.
      sourcemap: "hidden",
      rollupOptions: {
        // ws's optional perf deps — left as runtime requires so ws's internal
        // try/catch falls back to its pure-JS implementations.
        external: ["bufferutil", "utf-8-validate"],
        input: {
          index: resolve("src/main/index.ts"),
          // Persistent, headless backend host; spawned detached by the app via
          // ELECTRON_RUN_AS_NODE. Owns DB/broker/gate/PTYs and serves the GUI.
          host: resolve("src/main/host/index.ts"),
          // Per-agent MCP server (`opentrade`): cron/monitor tools over stdio,
          // spawned by `claude` (interactive + headless) per each agent's .mcp.json.
          // Dependency-free → self-contained bundle, robust under asar.
          "agent-mcp": resolve("src/agent-mcp/index.ts"),
          // Per-agent Kalshi MCP server (`kalshi`): a stdio shim over the host's
          // `/kalshi/call` (host signs with the vault key and gates writes). Same
          // self-contained constraints as agent-mcp.
          "kalshi-mcp": resolve("src/agent-mcp/kalshi.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define,
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      // See the main build: hidden maps, published as a Release asset, never shipped.
      sourcemap: "hidden",
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), tailwindcss()],
    define,
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer"),
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      // Emit sourcemaps so sanitized renderer stack fingerprints (bundle file:line —
      // see shared/analytics.ts) resolve back to source. "hidden" keeps them out of the
      // shipped bundle (no sourceMappingURL comment; also excluded in electron-builder.yml)
      // — they're published as a GitHub Release asset for triage, not handed to users.
      sourcemap: "hidden",
      rollupOptions: {
        input: { index: resolve("src/renderer/index.html") },
      },
    },
  },
});

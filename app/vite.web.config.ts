import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The renderer built as a plain web app for OpenTrade Cloud (served by the gateway).
// Same source as the desktop renderer: with no preload bridge, lib/trpc.ts talks to the
// user's sandbox same-origin. Output: out/web.
const channel = process.env.OPENTRADE_CHANNEL === "nightly" ? "nightly" : "stable";

/** The desktop CSP allows only the loopback host; the web app talks same-origin. */
function webCsp(): Plugin {
  return {
    name: "opentrade-web-csp",
    transformIndexHtml(html) {
      return html
        .replace(
          /connect-src 'self'[^;]*;/,
          "connect-src 'self' wss: https://us.i.posthog.com https://us-assets.i.posthog.com;",
        )
        .replace(
          "<title>OpenTrade</title>",
          `<title>OpenTrade</title>
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" content="#05060a" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="apple-touch-icon" href="/icon-192.png" />`,
        );
    },
  };
}

export default defineConfig({
  root: "src/renderer",
  base: "/",
  plugins: [react(), tailwindcss(), webCsp()],
  define: { __OPENTRADE_CHANNEL__: JSON.stringify(channel) },
  resolve: {
    alias: {
      "@renderer": resolve("src/renderer"),
      "@shared": resolve("src/shared"),
    },
  },
  publicDir: resolve("web-public"),
  build: {
    outDir: resolve("out/web"),
    emptyOutDir: true,
    sourcemap: "hidden",
  },
});

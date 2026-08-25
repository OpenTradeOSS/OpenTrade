# OpenTrade website

The marketing site for OpenTrade. A static single-page app: Vite + React 19 + Tailwind CSS v4,
with components managed through the [shadcn CLI](https://ui.shadcn.com/docs/cli)
(`components.json`).

```sh
bun install                     # from the repo root (bun workspaces)
bun run --cwd website dev       # dev server with HMR
bun run --cwd website build     # typecheck + production bundle → website/dist/
bun run --cwd website preview   # serve the production bundle locally
```

## Layout

- `src/App.tsx` — page composition.
- `src/components/templates/creative-studio/` — the hero section. Started from the
  [Hirael "Creative Studio"](https://hirael.com/embed/templates/creative-studio) registry
  template (`bunx shadcn@latest add https://hirael.com/r/creative-studio.json`), trimmed to
  the first screen and adapted for OpenTrade. `fonts.ts` replaces the template's
  `next/font` loader: the faces are linked from Google Fonts in `index.html` and exposed as
  `--font-*` tokens in `src/index.css`.
- `src/lib/utils.ts` — shadcn's `cn()` helper.
- `src/lib/analytics.ts` — PostHog. See below.
- `src/assets/app-window.jpg` — the app screenshot shown in the hero. Derived from the
  README's `assets/demo.png` by cropping to the window's bounds (the source has a black
  margin with the macOS shadow baked in, which would show as a box over the gradient).
  Regenerate when `demo.png` changes.

## Analytics

PostHog (`posthog-js`), in a **separate project from the app's telemetry**. The two share no
`distinct_id` — a browser visitor and an app install cannot be joined — so a separate project
keeps the app's curated event taxonomy, Persons list, and dashboards uncontaminated by web
traffic and autocapture.

What it collects: `$pageview` and autocapture (which is what PostHog's Web Analytics
dashboard runs on), plus two hand-written events — `download_clicked` and `github_clicked`,
one per call-to-action.

Configuration lives in `src/lib/analytics.ts`. Ingestion points at `https://r.exla.ai`, the
same PostHog reverse proxy the app uses: a first-party-looking domain that ad blockers don't
eat, and one that forwards `/static/*` as well as the ingest and flags endpoints. It targets
PostHog's **US** cloud, so the project whose key is used here must live in the US region.

### The key

Set `VITE_POSTHOG_KEY` to the website project's API key. It is a **write-only, public**
key — Vite bakes it into the client bundle by design, and it is not a secret.

- **Deploys:** set it in the host's build environment (e.g. Cloudflare Pages → Settings →
  Environment variables).
- **Locally:** put it in `website/.env.local` if you want to exercise a production build.
  (There is no checked-in `.env.example`: the repo's root `.gitignore` excludes that
  filename at every depth.)

Analytics is **inert** unless the key is set *and* the build is a production build, so
`bun run dev` never sends anything to the project.

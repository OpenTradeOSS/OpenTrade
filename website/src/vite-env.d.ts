/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project API key for the website's own analytics project. Write-only and safe
   *  to ship in client JS. Unset in dev and in local builds; set in the deploy environment,
   *  which leaves analytics inert everywhere else. */
  readonly VITE_POSTHOG_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

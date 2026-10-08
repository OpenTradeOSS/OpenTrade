#!/usr/bin/env bash
# Prepare the user's home on the volume, then run the host in the foreground.
set -euo pipefail

mkdir -p "$HOME"
# The volume is mounted over /data at runtime (root-owned on first boot on some
# providers); the image's useradd home is therefore recreated here.
cd "$HOME"

# Claude Code: skip first-run onboarding and pre-approve the gateway-issued API key, so
# an agent's interactive session never stops on a prompt nobody can see.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  node -e '
    const fs = require("fs"); const p = process.env.HOME + "/.claude.json";
    let c = {}; try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    const tail = process.env.ANTHROPIC_API_KEY.slice(-20);
    c.hasCompletedOnboarding = true;
    c.theme = c.theme || "dark";
    c.customApiKeyResponses = c.customApiKeyResponses || { approved: [], rejected: [] };
    if (!c.customApiKeyResponses.approved.includes(tail)) c.customApiKeyResponses.approved.push(tail);
    fs.writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
  '
fi

# Codex: route through the gateway's metering proxy with the sandbox key.
if [ -n "${OPENAI_API_KEY:-}" ] && [ ! -f "$HOME/.codex/auth.json" ]; then
  mkdir -p "$HOME/.codex"
  printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1 || true
fi

if [ "${OPENTRADE_DEMO_APPROVALS:-}" = "1" ]; then
  /opt/opentrade/demo-approvals.sh &
fi

exec node /opt/opentrade/app/out/main/host.js

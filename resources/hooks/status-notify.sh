#!/bin/bash
# OpenTrade status hook (Notification / Stop / StopFailure).
#
# Forwards the Claude Code hook payload to the app's local server, which dispatches
# on hook_event_name: Notification → needs-input; Stop → clears needs-input + captures
# session_id for the Resume button; StopFailure (fires instead of Stop on an API-error
# turn) → the same, plus the outstanding wake is recorded as failed with the payload's
# error category. Fire-and-forget with a short timeout so it never
# delays Claude Code; always exits 0.

INPUT=$(cat)

# Codex runs hooks with a cleaned env — recover the stable endpoint from the host
# manifest (the launcher's own discovery contract). Claude inherits the PTY env,
# so this is a no-op there.
if [ -z "${OPENTRADE_PORT}" ] || [ -z "${OPENTRADE_TOKEN}" ]; then
  MANIFEST="${OPENTRADE_HOME:-$HOME/.opentrade}/host.json"
  if [ -f "$MANIFEST" ]; then
    OPENTRADE_PORT=$(sed -n 's/.*"faucetPort":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$MANIFEST")
    OPENTRADE_TOKEN=$(sed -n 's/.*"token":[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST")
  fi
fi

if [ -n "${OPENTRADE_PORT}" ] && [ -n "${OPENTRADE_TOKEN}" ]; then
  printf '%s' "$INPUT" | curl -s --max-time 5 \
    -H "x-opentrade-token: ${OPENTRADE_TOKEN}" \
    -H "x-opentrade-agent: ${OPENTRADE_AGENT_ID}" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "http://127.0.0.1:${OPENTRADE_PORT}/hook/status" >/dev/null 2>&1 || true
fi

exit 0

#!/usr/bin/env bash
# Demo only: raise a pending order approval for an agent, as the agent's approval hook
# would. Used to seed the App Review / screenshot account. Run inside a sandbox:
#   seed-approval.sh <agent-id> <symbol> <side> <qty> <limit>
# It long-polls until decided (or times out), so run it in the background.
set -euo pipefail
M="${OPENTRADE_HOME:-$HOME/.opentrade}/host.json"
PORT=$(sed -n 's/.*"faucetPort":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$M")
TOKEN=$(sed -n 's/.*"token":[[:space:]]*"\([^"]*\)".*/\1/p' "$M")
curl -s --max-time 400 "http://127.0.0.1:${PORT}/hook/pretool-approval" \
  -H "x-opentrade-token: ${TOKEN}" -H "x-opentrade-agent: $1" -H "content-type: application/json" \
  -d "{\"tool_name\":\"mcp__robinhood__place_equity_order\",\"tool_input\":{\"symbol\":\"$2\",\"side\":\"$3\",\"quantity\":$4,\"type\":\"limit\",\"limit_price\":\"$5\"}}"

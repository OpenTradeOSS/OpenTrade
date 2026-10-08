#!/usr/bin/env bash
# Demo workspaces only (OPENTRADE_DEMO_APPROVALS=1, set on the App Review account's
# machine): keep one sample order waiting for approval, so a reviewer opening the app sees
# the approval flow. No broker is connected to a demo workspace, so a decision has no
# effect beyond the demo's own activity log.
set -uo pipefail
M="${OPENTRADE_HOME:-$HOME/.opentrade}/host.json"
ORDERS=("NVDA buy 5 182.50" "AAPL buy 10 228.00" "MSFT sell 3 512.25" "AMZN buy 4 221.40")
i=0
while true; do
  sleep 20
  [ -f "$M" ] || continue
  AGENT=$(node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    fetch(`http://127.0.0.1:${m.trpcPort}/agents.list`, { headers: { "x-opentrade-token": m.token } })
      .then((r) => r.json()).then((b) => console.log(b.result.data.json[0]?.id ?? ""))
      .catch(() => console.log(""));' "$M")
  [ -n "$AGENT" ] || continue
  read -r SYM SIDE QTY PX <<<"${ORDERS[$((i % ${#ORDERS[@]}))]}"
  i=$((i + 1))
  /opt/opentrade/seed-approval.sh "$AGENT" "$SYM" "$SIDE" "$QTY" "$PX" >/dev/null 2>&1
done

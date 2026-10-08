# OpenTrade Cloud

The hosted version of OpenTrade. Each user gets a private sandbox running the same
OpenTrade host the desktop app runs, behind a gateway that handles accounts, billing,
metered model access and push notifications. The browser runs the desktop app's renderer
as a web app; the iPhone app (`../mobile`) talks to the same gateway.

```
browser / iPhone ──HTTPS──► gateway (cloud/gateway, Bun)          opentrade-gateway on Fly
                              │  accounts, sessions, Stripe, push, /llm metering proxy
                              ▼  tRPC + WebSocket, per user, over Fly's private network
                            sandbox (cloud/sandbox image)          opentrade-sandbox on Fly
                              ├─ OpenTrade host in hosted mode (app/src/main/host)
                              │    edge on :8080: /trpc, /sessions/*, /oauth/relay
                              ├─ claude / codex CLIs, agent MCPs
                              └─ volume at /data (~/.opentrade, ~/.claude, ~/.codex)
```

## How the pieces fit

- **Hosted mode** (`OPENTRADE_HOSTED=1`, `app/src/main/host/hosted.ts`): the host starts
  an edge server (`edge.ts`) on one port. It accepts only the gateway (per-sandbox
  secret), injects the host token itself, and proxies tRPC HTTP, tRPC WebSocket, the
  terminal WebSocket, and OAuth callbacks to the host's loopback servers.
- **Model access**: sandboxes never hold a provider key. `ANTHROPIC_BASE_URL` /
  `OPENAI_BASE_URL` point at the gateway's `/llm/*` proxy with a per-sandbox key; the
  gateway swaps in the platform key (debiting credits) or the user's own key (BYOK, no
  debit) and records token usage per agent (`x-opentrade-agent` header).
- **Approvals on the phone**: the host posts `approval.pending` to the gateway
  (`hosted-notify.ts`), which sends Expo push (iPhone) and Web Push (installed web app).
- **Broker OAuth**: the Robinhood consent redirects to
  `<gateway>/oauth/relay/<port>/callback`; the gateway relays it to the loopback listener
  inside the sandbox. Agent CLI logins that redirect to `http://localhost:…` are finished
  by pasting the URL at `<gateway>/oauth/finish`.
- **Plans** (`gateway/src/plans.ts`): Free (2 agents, starter credits, bring your own
  key), Pro and Max (monthly credits, more agents). 1 credit = $0.01 of model usage at
  list price × `CREDIT_MARGIN`.

## Run it locally

```bash
cd app && bun run build && bun run build:web && cd ..
docker build -f cloud/sandbox/Dockerfile -t opentrade-sandbox .
cd cloud/gateway
GATEWAY_MASTER_KEY=$(openssl rand -hex 32) \
GATEWAY_URL_FOR_SANDBOX=http://host.docker.internal:8787 \
bun src/index.ts            # http://localhost:8787, sandboxes as local Docker containers
```

## Deploy (Fly.io, org `exla`)

Sandbox image (no public IPs on this app; machines are created by the gateway):

```bash
fly auth docker
TAG=$(git rev-parse --short HEAD)-$(date +%s)
docker buildx build --platform linux/amd64 -f cloud/sandbox/Dockerfile \
  -t registry.fly.io/opentrade-sandbox:$TAG --push .
fly secrets set -a opentrade-gateway SANDBOX_IMAGE=registry.fly.io/opentrade-sandbox:$TAG
```

Gateway (from the repo root, after `bun run build:web`):

```bash
fly deploy -c cloud/gateway/fly.toml --dockerfile cloud/gateway/Dockerfile --local-only --ha=false .
```

Gateway secrets:

| Secret | What |
|---|---|
| `GATEWAY_MASTER_KEY` | 64 hex chars; seals BYOK keys and sandbox secrets. Losing it orphans them. |
| `GATEWAY_PUBLIC_URL` | e.g. `https://opentrade-gateway.fly.dev` |
| `FLY_API_TOKEN` | deploy token for `opentrade-sandbox` (creates machines + volumes) |
| `SANDBOX_IMAGE` | the pushed sandbox image |
| `PLATFORM_ANTHROPIC_API_KEY` / `PLATFORM_OPENAI_API_KEY` | keys that credits pay for |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | billing (see below) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push (`bunx web-push generate-vapid-keys`) |

Stripe catalog and webhook (idempotent; prints the webhook secret on first run):

```bash
cd cloud/gateway
STRIPE_SECRET_KEY=sk_test_… GATEWAY_PUBLIC_URL=https://opentrade-gateway.fly.dev bun scripts/stripe-setup.ts
```

Existing sandboxes keep their image until upgraded; new signups get `SANDBOX_IMAGE`.

## Known gaps

- Sandboxes are always on (≈$10/mo each at shared-cpu-1x/2GB). Free-tier sleep-and-wake
  needs the scheduler to move into the gateway.
- No email verification or password reset yet.
- Sandbox image upgrades for existing users are manual (`Sandboxes.upgrade`).
- A stream the client abandons mid-response isn't metered.

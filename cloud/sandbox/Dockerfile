# OpenTrade Cloud sandbox: one per user. Runs the unchanged OpenTrade host (the same
# bundle the desktop app spawns) in hosted mode, plus the agent CLIs it drives.
#
# Build from the repo root after building the JS bundles:
#   (cd app && bun run build)
#   docker build -f cloud/sandbox/Dockerfile -t opentrade-sandbox .
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq python3 python3-pip python3-venv tini \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs. Pinned by the image build date; bump deliberately.
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

WORKDIR /opt/opentrade/app
COPY cloud/sandbox/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force \
    && apt-get purge -y build-essential && apt-get autoremove -y

# Same layout as the repo, so the host's path resolvers (templates/, resources/hooks)
# find their assets relative to out/main.
COPY app/out/main ./out/main
COPY templates /opt/opentrade/templates
COPY resources /opt/opentrade/resources
COPY cloud/sandbox/entrypoint.sh cloud/sandbox/seed-approval.sh cloud/sandbox/demo-approvals.sh /opt/opentrade/

# Everything the user owns lives on the persistent volume: OpenTrade's data home,
# each agent's workspace, and the CLIs' own config (~/.claude, ~/.codex).
RUN useradd --create-home --home-dir /data/home --shell /bin/bash trader \
    && mkdir -p /data && chown -R trader:trader /data
ENV HOME=/data/home \
    OPENTRADE_HOSTED=1 \
    OPENTRADE_EDGE_PORT=8080 \
    NODE_ENV=production
EXPOSE 8080
USER trader
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/opentrade/entrypoint.sh"]

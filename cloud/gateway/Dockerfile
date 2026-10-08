# OpenTrade Cloud gateway. Build from the repo root after `bun run build:web` in app/:
#   docker build -f cloud/gateway/Dockerfile -t opentrade-gateway .
FROM oven/bun:1.3-slim
WORKDIR /opt/gateway
COPY cloud/gateway/package.json ./package.json
RUN bun install --production
COPY cloud/gateway/src ./src
COPY app/out/web /opt/web
ENV GATEWAY_WEB_DIR=/opt/web \
    GATEWAY_DB=/data/gateway.db \
    PORT=8787 \
    NODE_ENV=production
EXPOSE 8787
CMD ["bun", "src/index.ts"]

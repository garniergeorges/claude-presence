# syntax=docker/dockerfile:1.7
# Multi-stage build for claude-presence-server (HTTP MCP).
# Final image: ~120 MB, runs as non-root, healthcheck on /healthz.

# ---- Build stage ----
FROM node:22-alpine AS builder

# Native deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev deps
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-alpine AS runtime

# wget for healthcheck, ca-certificates for outbound TLS if ever needed
RUN apk add --no-cache wget ca-certificates && \
    addgroup -g 1000 cp && \
    adduser -D -u 1000 -G cp cp && \
    mkdir -p /var/lib/claude-presence && \
    chown -R cp:cp /var/lib/claude-presence

WORKDIR /app
COPY --from=builder --chown=cp:cp /app/dist ./dist
COPY --from=builder --chown=cp:cp /app/node_modules ./node_modules
COPY --from=builder --chown=cp:cp /app/package.json ./

USER cp

ENV NODE_ENV=production
ENV CLAUDE_PRESENCE_DB=/var/lib/claude-presence/state.db
ENV PORT=3471
ENV HOST=0.0.0.0
ENV LOG_LEVEL=info

EXPOSE 3471

VOLUME ["/var/lib/claude-presence"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["node", "dist/server/index.js"]
CMD ["--host", "0.0.0.0"]

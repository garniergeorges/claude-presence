# syntax=docker/dockerfile:1.7
# Multi-stage build for claude-presence-server (HTTP MCP).
# Three stages so the runtime gets ONLY production deps (no vitest, no esbuild,
# no typescript). Trivy then scans a clean tree.

# ---- Stage 1: production deps (clean install --omit=dev) ----
FROM node:22-alpine AS prod-deps

# Native deps for better-sqlite3 (required by npm install since prebuilt
# binaries may not exist for the target platform).
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Stage 2: build (full deps to compile TS) ----
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 3: runtime (slim, prod deps only) ----
FROM node:22-alpine AS runtime

# wget for healthcheck, ca-certificates for outbound TLS if ever needed.
# The base image already provides a `node` user (uid 1000); we reuse it.
# We also remove the npm bundled with the base image because:
#   - the runtime only invokes `node`, never `npm`
#   - bundled npm pulls in transitive deps (picomatch, etc.) that
#     occasionally trigger Trivy CVE alerts unrelated to our code
RUN apk add --no-cache wget ca-certificates && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
    mkdir -p /var/lib/claude-presence && \
    chown -R node:node /var/lib/claude-presence

WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=prod-deps --chown=node:node /app/package.json ./

USER node

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

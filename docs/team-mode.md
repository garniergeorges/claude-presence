# Team mode — deploy guide

> 🇫🇷 [Version française](./team-mode.fr.md)

This guide walks through deploying `claude-presence-server` so that several developers across machines can coordinate on the same shared resources (CI, deploys, ports, staging databases).

If you are a single developer with several Claude Code sessions on one laptop, you do not need this. The default stdio binary `claude-presence-mcp` already handles your case via local SQLite. Stay there.

---

## Table of contents

- [When to use team mode](#when-to-use-team-mode)
- [Architecture](#architecture)
- [Bootstrap: create the first admin token](#bootstrap-create-the-first-admin-token)
- [Deploy paths](#deploy-paths)
  - [Path 1 — Docker Compose on a VPS](#path-1--docker-compose-on-a-vps)
  - [Path 2 — Docker Compose with Caddy + HTTPS](#path-2--docker-compose-with-caddy--https)
  - [Path 3 — Bare metal with `npx` + systemd](#path-3--bare-metal-with-npx--systemd)
  - [Path 4 — Kubernetes](#path-4--kubernetes)
- [Client configuration](#client-configuration)
- [Token management](#token-management)
- [Backup and restore](#backup-and-restore)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

---

## When to use team mode

| You are... | Use this |
|---|---|
| Solo, multiple Claude Code sessions on one laptop | stdio mode (`claude-presence-mcp`), no team mode needed |
| Pair programming on a shared dev box | stdio mode is sufficient |
| Several developers on their own laptops, same repo | **team mode** (this guide) |
| CI runners that should respect locks held by humans | **team mode** with a dedicated `ci-bot` token |

Team mode trades simplicity (zero daemon, zero network) for cross-machine coordination. Pick deliberately.

## Architecture

```
laptop A          laptop B          laptop C (CI runner)
    │                 │                 │
    └─── Bearer ──────┴────── Bearer ──┘
              token, RBAC scope
                       │
                       ▼
            ┌──────────────────────┐
            │ claude-presence-     │
            │   server (HTTP)      │
            │                      │
            │ /var/lib/.../state.db│
            └──────────────────────┘
                  Self-hosted.
                  No cloud, no telemetry.
```

The server is a single-replica process backed by SQLite. Sessions identify themselves through bearer tokens and a session_id of their choice. RBAC restricts which MCP tools each token can call.

## Bootstrap: create the first admin token

Whichever deploy path you pick, the server **refuses to start without at least one active admin token** (unless `--no-auth` is passed). The bootstrap step is the same:

```bash
# Inside the server's environment (Docker exec, kubectl exec, or local shell):
node dist/server/index.js token create --name admin --scope admin
# Save the printed cp_... token. It is shown ONCE.
```

The token is hashed with SHA-256 and only the hash is stored. Losing the plaintext means revoking and recreating.

## Deploy paths

### Path 1 — Docker Compose on a VPS

**Audience:** small team, 3-10 developers, you have a tiny VPS or a homelab box.
**Time:** ~5 minutes.

```bash
git clone https://github.com/garniergeorges/claude-presence
cd claude-presence/deploy
docker compose up -d

# Bootstrap admin token
docker compose exec claude-presence \
  node dist/server/index.js token create --name admin --scope admin

# Verify
curl http://localhost:3471/healthz
# {"status":"ok","version":"...","uptime_seconds":...,"db":"ok",...}
```

The server listens on `127.0.0.1:3471` only. For LAN access, change the host binding in `deploy/docker-compose.yml` (port mapping) or use Path 2 to expose with TLS.

### Path 2 — Docker Compose with Caddy + HTTPS

**Audience:** team with a public domain, want HTTPS with no manual certificate work.
**Time:** ~15 minutes.

Prerequisites: a domain pointing (A or AAAA record) to the host, ports 80 and 443 reachable from the internet.

```bash
cd claude-presence/deploy

# Configure
cp .env.example .env
echo "CADDY_DOMAIN=claude-presence.example.com" >> .env
cp Caddyfile.example Caddyfile

# Start (Caddy auto-issues the cert on first request)
docker compose -f docker-compose.caddy.yml up -d

# Bootstrap admin token
docker compose -f docker-compose.caddy.yml exec claude-presence \
  node dist/server/index.js token create --name admin --scope admin

# Wait ~30s, then verify
curl https://claude-presence.example.com/healthz
```

### Path 3 — Bare metal with `npx` + systemd

**Audience:** team that does not run containers, prefers OS-level service management.
**Time:** ~10 minutes.

Prerequisites: Node.js 18+ on the host.

```bash
# Install globally (or use a project-local install per your conventions)
npm install -g claude-presence

# Create a system user and data directory
sudo useradd --system --create-home --home-dir /var/lib/claude-presence cp
sudo -u cp mkdir -p /var/lib/claude-presence

# Bootstrap admin token
sudo -u cp env CLAUDE_PRESENCE_DB=/var/lib/claude-presence/state.db \
  claude-presence-server token create --name admin --scope admin
```

Create `/etc/systemd/system/claude-presence.service`:

```ini
[Unit]
Description=claude-presence MCP server
After=network.target

[Service]
Type=simple
User=cp
Group=cp
WorkingDirectory=/var/lib/claude-presence
Environment=CLAUDE_PRESENCE_DB=/var/lib/claude-presence/state.db
Environment=HOST=127.0.0.1
Environment=PORT=3471
Environment=LOG_LEVEL=info
ExecStart=/usr/bin/claude-presence-server
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/claude-presence
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-presence
sudo systemctl status claude-presence
curl http://127.0.0.1:3471/healthz
```

For HTTPS, put nginx, Caddy, or Traefik in front.

### Path 4 — Kubernetes

**Audience:** team already running on Kubernetes.
**Time:** depends on cluster setup.

```bash
git clone https://github.com/garniergeorges/claude-presence
cd claude-presence

kubectl apply -f deploy/k8s/pvc.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml

# Bootstrap admin token
kubectl exec deploy/claude-presence -- \
  node dist/server/index.js token create --name admin --scope admin

# Verify locally
kubectl port-forward svc/claude-presence 3471:3471
curl http://localhost:3471/healthz
```

For external traffic, add an Ingress (any controller) or change the Service type to LoadBalancer. The Deployment uses `Recreate` strategy because SQLite is single-writer; high availability requires the Postgres backend planned for v0.3.

## Client configuration

Each Claude Code session points at the server via `.mcp.json` at the project root.

For a local server (Path 1):

```json
{
  "mcpServers": {
    "claude-presence": {
      "type": "http",
      "url": "http://127.0.0.1:3471/mcp",
      "headers": {
        "Authorization": "Bearer cp_REPLACE_WITH_YOUR_TOKEN"
      }
    }
  }
}
```

For a public server (Path 2):

```json
{
  "mcpServers": {
    "claude-presence": {
      "type": "http",
      "url": "https://claude-presence.example.com/mcp",
      "headers": {
        "Authorization": "Bearer cp_REPLACE_WITH_YOUR_TOKEN"
      }
    }
  }
}
```

Each developer should have their own named token, never share a single token across humans.

## Token management

```bash
# Create a token (admin can also restrict to specific tools via --tools)
claude-presence-server token create --name alice --scope write
claude-presence-server token create --name ci-bot --scope write \
  --tools resource_claim,resource_release \
  --notes "Used by GitHub Actions"

# List active and revoked tokens
claude-presence-server token list

# Show details
claude-presence-server token show --name alice

# Revoke (effective immediately)
claude-presence-server token revoke --name alice
```

Rotation: revoke + recreate. The server restart is not required.

## Backup and restore

The entire state is in one SQLite file (default `/var/lib/claude-presence/state.db`).

Backup (Compose variant):

```bash
docker run --rm \
  -v claude-presence_claude-presence-data:/data \
  -v "$(pwd)":/backup \
  alpine tar czf /backup/cp-backup-$(date +%F).tar.gz -C /data .
```

Restore: stop the container, untar onto the volume, start again. Always test the restore drill before you need it.

## Monitoring

- **Health endpoint**: `GET /healthz` returns 200 OK with JSON status. 503 when the SQLite probe fails.
- **Logs**: structured JSON on stderr. Configurable via `LOG_LEVEL` (default `info`). Each line is one event.
- **Audit log**: every authenticated tool call is recorded in the `audit_log` table. Query with `sqlite3`:

```bash
sqlite3 state.db \
  "SELECT timestamp, token_id, tool_name, result_status FROM audit_log ORDER BY timestamp DESC LIMIT 20;"
```

## Troubleshooting

**`server refuses to start: no active admin token`**
You did not bootstrap. See [Bootstrap: create the first admin token](#bootstrap-create-the-first-admin-token). Or pass `--no-auth` (localhost only, NOT recommended).

**`401 missing_authorization`**
The `.mcp.json` does not include the `Authorization: Bearer ...` header. Re-check the example above.

**`401 invalid_token`**
The token is wrong or revoked. Run `token list` to confirm. Recreate if needed.

**`permission_denied` on `resource_claim`**
The token has `read` scope. Either upgrade the scope or grant explicit overrides via `--tools resource_claim,resource_release`.

**`force_release_requires_admin`**
You passed `force: true` on `resource_release` from a non-admin token. Force-release is admin-only by design.

**Caddy fails to issue the certificate**
Check that ports 80 and 443 are reachable from the public internet, and that DNS points correctly to the host. Look at Caddy logs: `docker compose logs caddy`.

**SQLite locked errors**
Should not happen with a single-replica deployment. If it does, you have multiple writers; in Kubernetes verify the Deployment uses `Recreate` strategy and only one replica.

---

For deeper changes (Postgres backend, HA replication), see the [v0.3 milestone](https://github.com/garniergeorges/claude-presence/milestones).

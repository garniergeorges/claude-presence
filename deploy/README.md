# claude-presence — deployment manifests

Three ready-to-use deployment variants, each in this directory.

| File / dir | Use case | Time to ready |
|---|---|---|
| `docker-compose.yml` | Localhost or LAN, no TLS | ~5 min |
| `docker-compose.caddy.yml` + `Caddyfile.example` | Public domain with auto HTTPS | ~15 min |
| `k8s/*.yaml` | Kubernetes cluster | depends on cluster |

For step-by-step instructions in EN/FR (token bootstrap, client config, backup, monitoring, troubleshooting), see [`docs/team-mode.md`](../docs/team-mode.md).

## Quick reference

### 1. Localhost Docker Compose

```bash
cd deploy
docker compose up -d
docker compose exec claude-presence node dist/server/index.js \
  token create --name admin --scope admin
curl http://localhost:3471/healthz
```

### 2. Public domain with Caddy

```bash
cd deploy
cp .env.example .env       # set CADDY_DOMAIN
cp Caddyfile.example Caddyfile
docker compose -f docker-compose.caddy.yml up -d
# Wait ~30s for Let's Encrypt issuance, then:
curl https://your-domain.com/healthz
```

### 3. Kubernetes

```bash
kubectl apply -f deploy/k8s/pvc.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
kubectl exec deploy/claude-presence -- node dist/server/index.js \
  token create --name admin --scope admin
kubectl port-forward svc/claude-presence 3471:3471
curl http://localhost:3471/healthz
```

For external traffic, add an Ingress or change the Service type to LoadBalancer. The Deployment uses `Recreate` strategy and one replica because SQLite is single-writer; HA requires the Postgres backend (roadmap, v0.3+).

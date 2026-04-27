# Mode équipe — guide de déploiement

> 🇬🇧 [English version](./team-mode.md)

Ce guide montre comment déployer `claude-presence-server` pour que plusieurs développeurs sur des machines différentes coordonnent leurs ressources partagées (CI, déploiements, ports, bases de staging).

Si tu es seul avec plusieurs sessions Claude Code sur un même laptop, tu n'as pas besoin de ça. Le binaire stdio par défaut `claude-presence-mcp` couvre déjà ton cas avec SQLite local. Reste là.

---

## Table des matières

- [Quand utiliser le mode équipe](#quand-utiliser-le-mode-équipe)
- [Architecture](#architecture)
- [Bootstrap : créer le premier token admin](#bootstrap--créer-le-premier-token-admin)
- [Chemins de déploiement](#chemins-de-déploiement)
  - [Chemin 1 — Docker Compose sur un VPS](#chemin-1--docker-compose-sur-un-vps)
  - [Chemin 2 — Docker Compose avec Caddy + HTTPS](#chemin-2--docker-compose-avec-caddy--https)
  - [Chemin 3 — Sans conteneur, avec `npx` + systemd](#chemin-3--sans-conteneur-avec-npx--systemd)
  - [Chemin 4 — Kubernetes](#chemin-4--kubernetes)
- [Configuration côté client](#configuration-côté-client)
- [Gestion des tokens](#gestion-des-tokens)
- [Sauvegarde et restauration](#sauvegarde-et-restauration)
- [Supervision](#supervision)
- [Dépannage](#dépannage)

---

## Quand utiliser le mode équipe

| Tu es... | Utilise |
|---|---|
| Seul, plusieurs sessions Claude Code sur un laptop | Mode stdio (`claude-presence-mcp`), pas besoin du mode équipe |
| Pair programming sur un poste partagé | Le mode stdio suffit |
| Plusieurs développeurs sur leurs propres laptops, même repo | **Mode équipe** (ce guide) |
| Runners CI qui doivent respecter les verrous des humains | **Mode équipe** avec un token `ci-bot` dédié |

Le mode équipe sacrifie la simplicité (zéro démon, zéro réseau) au profit de la coordination cross-machine. Choisis avec discernement.

## Architecture

```
laptop A          laptop B          laptop C (runner CI)
    │                 │                 │
    └─── Bearer ──────┴────── Bearer ──┘
              token, scope RBAC
                       │
                       ▼
            ┌──────────────────────┐
            │ claude-presence-     │
            │   server (HTTP)      │
            │                      │
            │ /var/lib/.../state.db│
            └──────────────────────┘
                  Auto-hébergé.
                  Pas de cloud, pas de télémétrie.
```

Le serveur est un processus en réplica unique sur fond SQLite. Les sessions s'identifient via des bearer tokens et un session_id de leur choix. Le RBAC restreint quels outils MCP chaque token peut appeler.

## Bootstrap : créer le premier token admin

Quel que soit le chemin de déploiement choisi, le serveur **refuse de démarrer sans au moins un token admin actif** (sauf passage de `--no-auth`). Le bootstrap est identique partout :

```bash
# Dans l'environnement du serveur (docker exec, kubectl exec, ou shell local) :
node dist/server/index.js token create --name admin --scope admin
# Sauvegarde le token cp_... affiché. Il n'apparaît qu'UNE SEULE FOIS.
```

Le token est haché en SHA-256 et seul le hash est stocké. Perdre le clair = révoquer et recréer.

## Chemins de déploiement

### Chemin 1 — Docker Compose sur un VPS

**Public visé** : petite équipe, 3-10 développeurs, tu as un petit VPS ou un serveur perso.
**Temps** : ~5 minutes.

```bash
git clone https://github.com/garniergeorges/claude-presence
cd claude-presence/deploy
docker compose up -d

# Bootstrap du token admin
docker compose exec claude-presence \
  node dist/server/index.js token create --name admin --scope admin

# Vérification
curl http://localhost:3471/healthz
# {"status":"ok","version":"...","uptime_seconds":...,"db":"ok",...}
```

Le serveur n'écoute que sur `127.0.0.1:3471`. Pour exposer sur le LAN, modifie le mapping de port dans `deploy/docker-compose.yml` ou utilise le Chemin 2 pour exposer en TLS.

### Chemin 2 — Docker Compose avec Caddy + HTTPS

**Public visé** : équipe avec un domaine public, qui veut HTTPS sans gestion manuelle de certificats.
**Temps** : ~15 minutes.

Prérequis : un domaine pointé (enregistrement A ou AAAA) vers la machine, ports 80 et 443 accessibles depuis Internet.

```bash
cd claude-presence/deploy

# Configuration
cp .env.example .env
echo "CADDY_DOMAIN=claude-presence.exemple.com" >> .env
cp Caddyfile.example Caddyfile

# Démarrage (Caddy obtient automatiquement le certificat à la première requête)
docker compose -f docker-compose.caddy.yml up -d

# Bootstrap du token admin
docker compose -f docker-compose.caddy.yml exec claude-presence \
  node dist/server/index.js token create --name admin --scope admin

# Attendre ~30s puis vérifier
curl https://claude-presence.exemple.com/healthz
```

### Chemin 3 — Sans conteneur, avec `npx` + systemd

**Public visé** : équipe qui ne fait pas de conteneurs, préfère gérer comme un service système.
**Temps** : ~10 minutes.

Prérequis : Node.js 18+ sur la machine.

```bash
# Installation globale (ou installation projet selon tes conventions)
npm install -g claude-presence

# Création de l'utilisateur système et du dossier de données
sudo useradd --system --create-home --home-dir /var/lib/claude-presence cp
sudo -u cp mkdir -p /var/lib/claude-presence

# Bootstrap du token admin
sudo -u cp env CLAUDE_PRESENCE_DB=/var/lib/claude-presence/state.db \
  claude-presence-server token create --name admin --scope admin
```

Crée `/etc/systemd/system/claude-presence.service` :

```ini
[Unit]
Description=Serveur MCP claude-presence
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

# Durcissement
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

Puis :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-presence
sudo systemctl status claude-presence
curl http://127.0.0.1:3471/healthz
```

Pour HTTPS, place nginx, Caddy ou Traefik devant.

### Chemin 4 — Kubernetes

**Public visé** : équipe déjà sur Kubernetes.
**Temps** : dépend de la configuration cluster.

```bash
git clone https://github.com/garniergeorges/claude-presence
cd claude-presence

kubectl apply -f deploy/k8s/pvc.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml

# Bootstrap du token admin
kubectl exec deploy/claude-presence -- \
  node dist/server/index.js token create --name admin --scope admin

# Vérification locale
kubectl port-forward svc/claude-presence 3471:3471
curl http://localhost:3471/healthz
```

Pour le trafic externe, ajoute un Ingress (n'importe quel controller) ou bascule le Service en LoadBalancer. Le Deployment utilise la stratégie `Recreate` parce que SQLite est single-writer ; la haute disponibilité nécessite le backend Postgres prévu pour v0.3.

## Configuration côté client

Chaque session Claude Code pointe vers le serveur via `.mcp.json` à la racine du projet.

Pour un serveur local (Chemin 1) :

```json
{
  "mcpServers": {
    "claude-presence": {
      "type": "http",
      "url": "http://127.0.0.1:3471/mcp",
      "headers": {
        "Authorization": "Bearer cp_REMPLACER_PAR_TON_TOKEN"
      }
    }
  }
}
```

Pour un serveur public (Chemin 2) :

```json
{
  "mcpServers": {
    "claude-presence": {
      "type": "http",
      "url": "https://claude-presence.exemple.com/mcp",
      "headers": {
        "Authorization": "Bearer cp_REMPLACER_PAR_TON_TOKEN"
      }
    }
  }
}
```

Chaque développeur doit avoir son propre token nommé. Ne jamais partager un même token entre plusieurs humains.

## Gestion des tokens

```bash
# Créer un token (admin peut aussi restreindre à des outils précis via --tools)
claude-presence-server token create --name alice --scope write
claude-presence-server token create --name ci-bot --scope write \
  --tools resource_claim,resource_release \
  --notes "Utilisé par GitHub Actions"

# Lister les tokens actifs et révoqués
claude-presence-server token list

# Détails d'un token
claude-presence-server token show --name alice

# Révocation (immédiate)
claude-presence-server token revoke --name alice
```

Rotation : révoquer + recréer. Pas besoin de redémarrer le serveur.

## Sauvegarde et restauration

Toute la donnée est dans un seul fichier SQLite (par défaut `/var/lib/claude-presence/state.db`).

Sauvegarde (variante Compose) :

```bash
docker run --rm \
  -v claude-presence_claude-presence-data:/data \
  -v "$(pwd)":/backup \
  alpine tar czf /backup/cp-backup-$(date +%F).tar.gz -C /data .
```

Restauration : arrêter le conteneur, dé-tarballer sur le volume, redémarrer. Toujours tester la procédure de restauration avant d'en avoir besoin.

## Supervision

- **Endpoint santé** : `GET /healthz` retourne 200 OK avec un JSON. 503 si le check SQLite échoue.
- **Logs** : JSON structuré sur stderr. Configurable via `LOG_LEVEL` (par défaut `info`). Une ligne par événement.
- **Journal d'audit** : chaque appel d'outil authentifié est tracé dans la table `audit_log`. Requête avec `sqlite3` :

```bash
sqlite3 state.db \
  "SELECT timestamp, token_id, tool_name, result_status FROM audit_log ORDER BY timestamp DESC LIMIT 20;"
```

## Dépannage

**`server refuses to start: no active admin token`**
Tu n'as pas fait le bootstrap. Voir [Bootstrap : créer le premier token admin](#bootstrap--créer-le-premier-token-admin). Ou passe `--no-auth` (localhost uniquement, NON recommandé).

**`401 missing_authorization`**
Le `.mcp.json` ne contient pas le header `Authorization: Bearer ...`. Re-vérifie l'exemple plus haut.

**`401 invalid_token`**
Le token est faux ou révoqué. Lance `token list` pour confirmer. Recrée si besoin.

**`permission_denied` sur `resource_claim`**
Le token a un scope `read`. Soit tu remontes le scope, soit tu accordes des overrides explicites via `--tools resource_claim,resource_release`.

**`force_release_requires_admin`**
Tu as passé `force: true` sur `resource_release` depuis un token non-admin. La force-release est réservée aux admins par conception.

**Caddy n'arrive pas à émettre le certificat**
Vérifie que les ports 80 et 443 sont accessibles depuis Internet, et que le DNS pointe bien vers la machine. Regarde les logs Caddy : `docker compose logs caddy`.

**Erreurs SQLite locked**
Ne devrait pas arriver en réplica unique. Si oui, tu as plusieurs writers ; en Kubernetes, vérifie que le Deployment utilise la stratégie `Recreate` avec un seul replica.

---

Pour les évolutions plus profondes (backend Postgres, réplication HA), voir le [milestone v0.3](https://github.com/garniergeorges/claude-presence/milestones).

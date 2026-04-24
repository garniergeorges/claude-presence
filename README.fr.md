# claude-presence

[![CI](https://github.com/garniergeorges/claude-presence/actions/workflows/ci.yml/badge.svg)](https://github.com/garniergeorges/claude-presence/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

<picture>
  <source media="(prefers-reduced-motion: no-preference)" srcset="./assets/banner.gif">
  <img alt="claude-presence — coordonne plusieurs sessions Claude Code sur le même dépôt" src="./assets/banner-static.png">
</picture>

> Serveur MCP minimal pour la coordination inter-sessions de Claude Code en parallèle.

🇬🇧 [English version](./README.md)

Quand tu lances plusieurs sessions Claude Code sur le même dépôt, elles ne se voient pas entre elles. Elles se marchent dessus sur la CI, poussent par-dessus les commits des autres, ou refont le même travail. `claude-presence` est un petit serveur MCP qui donne à chaque session une vue des autres — plus des verrous consultatifs sur les ressources partagées (CI, base de staging, ports, tout ce que tu nommes).

**Le périmètre est volontairement restreint.** Présence + verrous sur ressources + boîte aux lettres courte. Pas d'intégration git, pas d'orchestration de tâches, pas d'UI web. Si tu veux plus, regarde [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail).

---

## Table des matières

- [Démarrage rapide](#démarrage-rapide-60-secondes)
- [Fonctionnalités](#fonctionnalités)
- [Installation](#installation)
- [Configuration](#configuration)
- [Vérifier que ça marche](#vérifier-que-ça-marche)
- [Commandes slash](#commandes-slash-recommandé)
- [Hooks (optionnels)](#hooks-optionnels)
- [Outils MCP exposés](#outils-mcp-exposés)
- [CLI](#cli)
- [Dépannage](#dépannage)
- [Comparaison](#comparaison)
- [Stockage](#stockage)
- [Développement](#développement)
- [Statut](#statut)

---

## Démarrage rapide (60 secondes)

```bash
# 1. Installer le paquet globalement
git clone https://github.com/garniergeorges/claude-presence
cd claude-presence && npm install && npm run build && npm link

# 2. Installer les commandes slash pour toute session Claude Code
cp commands/*.md ~/.claude/commands/

# 3. Ajouter le serveur MCP dans chaque projet à coordonner
cd /chemin/vers/ton/projet
cat > .mcp.json <<'EOF'
{
  "mcpServers": {
    "claude-presence": { "type": "stdio", "command": "claude-presence-mcp" }
  }
}
EOF

# 4. Ouvre Claude Code dans ce projet et tape :
#    /register  → tu deviens visible aux autres sessions
#    /presence  → vois qui travaille sur le projet
#    /claim ci  → réserve la CI avant de pousser
```

C'est toute la boucle. Tout le reste ci-dessous, c'est du détail.

---

## Fonctionnalités

- **Registre de présence** — chaque session s'enregistre avec sa branche et son intention ; les autres la voient
- **Verrous sur ressources** — réserve une ressource nommée (`"ci"`, `"deploy:staging"`, `"port:3000"`) avant d'y toucher ; les autres obtiennent une réponse claire "occupée"
- **Boîte aux lettres** — dépose un court message visible par les autres sessions sur le même projet
- **Commandes slash** — `/register`, `/claim`, `/release`, `/presence` (sans cérémonie de frappe)
- **CLI** — `claude-presence status` montre les sessions actives hors Claude Code
- **Zéro démon** — adossé à SQLite, sans port, sans processus en arrière-plan
- **Nettoyage par TTL** — les sessions mortes (pas de heartbeat pendant 2 min) sont purgées automatiquement

## Installation

### Depuis les sources (actuel)

```bash
git clone https://github.com/garniergeorges/claude-presence
cd claude-presence
npm install
npm run build
npm link       # expose claude-presence-mcp et claude-presence globalement
```

### Depuis npm (quand publié)

```bash
npm install -g claude-presence
```

Ou invoque via `npx` directement depuis `.mcp.json` — pas besoin d'install globale.

## Configuration

Ajoute `claude-presence` au `.mcp.json` de ton projet :

```json
{
  "mcpServers": {
    "claude-presence": {
      "type": "stdio",
      "command": "claude-presence-mcp"
    }
  }
}
```

Si tu as déjà d'autres serveurs MCP, ajoute juste ce bloc à côté — ne remplace pas tout le fichier. Exemple avec une entrée `semgrep` existante :

```json
{
  "mcpServers": {
    "semgrep": {
      "type": "stdio",
      "command": "semgrep",
      "args": ["mcp"]
    },
    "claude-presence": {
      "type": "stdio",
      "command": "claude-presence-mcp"
    }
  }
}
```

### Installer les commandes slash (recommandé)

```bash
cp commands/*.md ~/.claude/commands/
```

Dans toute session Claude Code, tu peux maintenant taper `/register`, `/claim <ressource>`, `/release <ressource>`, `/presence`.

## Vérifier que ça marche

Après avoir configuré `.mcp.json`, redémarre Claude Code dans le projet, puis vérifie :

```bash
# Les binaires CLI et MCP doivent être dans le PATH :
which claude-presence           # → /opt/homebrew/bin/claude-presence (ou équivalent)
which claude-presence-mcp       # → même dossier

# Le CLI tourne :
claude-presence status          # → "No active sessions." au premier lancement
```

Dans Claude Code, tape `/mcp`. Tu dois voir `claude-presence` listé avec **9 outils**. Si absent, va voir [Dépannage](#dépannage).

Essaie ensuite `/register test` — la session doit s'enregistrer et la réponse de l'outil doit lister les autres sessions actives sur le projet.

## Commandes slash (recommandé)

Sans cérémonie. Tu tapes :

| Commande | Ce qu'elle fait |
|---|---|
| `/register [intention]` | Enregistre la session avec une intention optionnelle (branche et cwd détectés automatiquement). |
| `/claim <ressource> [raison]` | Réserve un verrou de ressource nommée. Si occupée, montre le détenteur au lieu de poursuivre. |
| `/release <ressource>` | Libère un verrou que tu détiens. |
| `/presence` | Montre les autres sessions et les verrous actifs sur ce projet. |

### Exemple de flux

La session A démarre sur `feat/login` :

```
/register correction du bug de redirection login
```

La session A s'apprête à pousser et déclencher la CI :

```
/claim ci je pousse feat/login
→ ok: true, détenu jusqu'à 10:05
```

Pendant ce temps, la session B sur `fix/nav` tente la même chose :

```
/claim ci je pousse fix/nav
→ ok: false — déjà détenu par session-a1b2 sur feat/login depuis 09:55
   Attendre, broadcaster, ou abandonner ?
```

La session A finit la CI et libère :

```
/release ci
```

La session B peut maintenant poursuivre.

## Hooks (optionnels)

Les commandes slash couvrent 99% de l'usage quotidien. Les hooks sont du polissage optionnel pour le dernier 1% :

- **`hooks/session-start.sh`** s'exécute à l'ouverture d'une nouvelle session Claude Code. Il affiche un rappel court pour que tu penses à `/register` et aux verrous de ressources avant les opérations partagées. Il **n'enregistre pas** la session automatiquement (c'est voulu — la commande slash garde l'enregistrement explicite).
- **`hooks/user-prompt-submit.sh`** s'exécute à chaque prompt utilisateur. Il injecte un message système d'une ligne dans le contexte quand d'autres sessions ou verrous sont actifs sur ce projet, pour que Claude Code reste au courant sans que tu le demandes.

> Le hook `UserPromptSubmit` appelle la CLI `claude-presence`, donc elle doit être dans ton `PATH` (géré par `npm link` ou `npm install -g`). Si la CLI est absente, le hook sort silencieusement avec 0 — pas de blocage.

### Activation

**Sauvegarde d'abord tes settings** :

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.backup-$(date +%Y%m%d-%H%M%S)
```

Puis fusionne les deux entrées de hook dans `~/.claude/settings.json`. Si la section `hooks` n'existe pas encore :

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "/chemin/absolu/vers/claude-presence/hooks/session-start.sh" }
      ]}
    ],
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "/chemin/absolu/vers/claude-presence/hooks/user-prompt-submit.sh" }
      ]}
    ]
  }
}
```

### Cohabitation avec des hooks existants

Si un autre outil enregistre déjà des hooks sur `SessionStart` ou `UserPromptSubmit` (GitKraken CLI, scripts maison, etc.), **ne les écrase pas** — ajoute une seconde entrée dans le même tableau `hooks`. Exemple en cohabitation avec GitKraken :

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "\"/Users/toi/Library/Application Support/GitKrakenCLI/gk\" ai hook run --host claude-code" },
        { "type": "command", "command": "/chemin/absolu/vers/claude-presence/hooks/session-start.sh" }
      ]}
    ],
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "\"/Users/toi/Library/Application Support/GitKrakenCLI/gk\" ai hook run --host claude-code" },
        { "type": "command", "command": "/chemin/absolu/vers/claude-presence/hooks/user-prompt-submit.sh" }
      ]}
    ]
  }
}
```

Claude Code exécute chaque commande du tableau dans l'ordre. Les deux outils s'exécutent.

## Outils MCP exposés

| Outil | Rôle |
|---|---|
| `session_register` | Déclare cette session (projet, branche, intention) |
| `session_heartbeat` | Garde la session vivante |
| `session_unregister` | Sortie propre |
| `session_list` | Liste les sessions actives sur le même projet |
| `resource_claim` | Acquiert un verrou consultatif sur une ressource nommée |
| `resource_release` | Libère un verrou |
| `resource_list` | Liste les verrous actifs |
| `broadcast` | Poste un message dans la boîte aux lettres du projet |
| `read_inbox` | Lit les messages récents |

## CLI

```bash
claude-presence status              # Montre toutes les sessions actives
claude-presence status --project .  # Filtre sur le projet courant
claude-presence locks               # Montre les verrous actifs
claude-presence clear               # Purge les sessions mortes et verrous expirés
claude-presence path                # Affiche le chemin de la base SQLite
claude-presence help                # Aide
```

Ajoute `--json` à n'importe quelle commande pour une sortie exploitable par script.

## Dépannage

**`/mcp` ne liste pas `claude-presence`.**
Vérifie que `.mcp.json` est à la racine du projet (même dossier que celui où tu as ouvert Claude Code), que le champ `command` pointe sur un exécutable du `PATH`, et que tu as **entièrement redémarré** Claude Code après édition (pas juste rechargé).

**`command not found: claude-presence-mcp`.**
Lance `which claude-presence-mcp`. Si vide, refais `npm link` depuis le dossier `claude-presence/`. Si tu as installé via `npm install -g`, vérifie que ton dossier bin global npm est dans ton `PATH` (`npm config get prefix`).

**Les commandes slash n'apparaissent pas.**
Les commandes slash sont chargées au démarrage de session. Redémarre Claude Code après `cp commands/*.md ~/.claude/commands/`. Tape `/` pour voir la liste.

**`claude-presence status` affiche 0 session alors que Claude Code est ouvert.**
`claude-presence` ne s'enregistre pas automatiquement — tu dois appeler `/register` une fois par session. C'est volontaire : les sessions restent explicites et identifiables.

**Un verrou est bloqué parce qu'une session a crashé.**
Les sessions mortes sont purgées après 2 min (pas de heartbeat). Tu peux forcer le nettoyage immédiat avec `claude-presence clear`, ou forcer la libération d'un verrou spécifique via l'outil MCP `resource_release` avec `force: true`.

**Les hooks semblent casser ma config GitKraken / un hook maison.**
Va voir [Cohabitation avec des hooks existants](#cohabitation-avec-des-hooks-existants). Chaque événement a un tableau de hooks ; ajoute le tien sans retirer les autres.

## Comparaison

| | claude-presence | [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | [parallel-cc](https://github.com/frankbria/parallel-cc) |
|---|---|---|---|
| Registre de présence | ✅ | ✅ | ✅ |
| Verrous au niveau fichier | ❌ | ✅ | ✅ |
| **Verrous de ressource nommée** (CI, ports, BDD) | ✅ | ⚠️ (via chemins fichiers) | ❌ |
| Messagerie | boîte minimale | boîte complète | ❌ |
| Intégration git | ❌ | ✅ | ✅ (worktrees) |
| Commandes slash fournies | ✅ | ❌ | ❌ |
| LOC | ~800 | plusieurs milliers | ~2000 |

Choisis `claude-presence` si tu veux quelque chose de petit et focalisé sur "que mes sessions ne se marchent pas dessus". Choisis `mcp_agent_mail` si tu veux des flux agent-à-agent riches.

## Stockage

Les données vivent dans `~/.claude-presence/state.db` (SQLite, mode WAL). Rien n'est envoyé ailleurs.

Pour changer le chemin : `CLAUDE_PRESENCE_DB=/chemin/personnalisé.db`.

Rétention :
- **Sessions** : purgées après 2 min sans heartbeat.
- **Verrous** : purgés à expiration du TTL (10 min par défaut, configurable par claim, max 24 h).
- **Boîte aux lettres** : purgée après 24 h.

## Développement

```bash
npm run build      # compile TypeScript
npm run dev        # mode watch
node dist/index.js # lance le serveur MCP directement (stdio)
```

Arborescence :

```
src/
  index.ts         # point d'entrée du serveur MCP (stdio)
  db/              # schéma SQLite et repository typé
  tools/           # implémentations des outils MCP (présence, verrous, boîte)
  cli/             # CLI claude-presence
hooks/             # scripts SessionStart et UserPromptSubmit
commands/          # commandes slash /register, /claim, /release, /presence
examples/          # .mcp.json d'exemple et extraits settings.json
```

## Statut

🚧 **v0.1 — développement initial.** L'API peut changer. Retours et PRs bienvenus sur [github.com/garniergeorges/claude-presence](https://github.com/garniergeorges/claude-presence).

## Licence

MIT

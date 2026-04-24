#!/usr/bin/env node
import { openDatabase, getDefaultDbPath } from "../db/index.js";
import { Repository } from "../db/repository.js";

const COMMANDS = ["status", "locks", "clear", "path", "help"] as const;
type Command = (typeof COMMANDS)[number];

function parseArgs(argv: string[]): {
  command: Command;
  project?: string;
  json: boolean;
  all: boolean;
} {
  const args = argv.slice(2);
  const command = ((args[0] ?? "status") as Command);
  let project: string | undefined;
  let json = false;
  let all = false;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--project" || a === "-p") {
      project = args[++i];
    } else if (a === "--json") {
      json = true;
    } else if (a === "--all") {
      all = true;
    }
  }
  return { command, project, json, all };
}

function formatRelative(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function printStatus(repo: Repository, project: string | undefined, json: boolean) {
  const sessions = repo.listSessions(project);
  if (json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }
  if (sessions.length === 0) {
    console.log("No active sessions.");
    return;
  }
  console.log(`${sessions.length} active session(s):\n`);
  for (const s of sessions) {
    console.log(`  • ${s.id}`);
    console.log(`    project : ${s.project}`);
    if (s.branch) console.log(`    branch  : ${s.branch}`);
    if (s.intent) console.log(`    intent  : ${s.intent}`);
    console.log(`    started : ${formatRelative(s.started_at)}`);
    console.log(`    seen    : ${formatRelative(s.last_heartbeat)}`);
    if (s.pid) console.log(`    pid     : ${s.pid}`);
    console.log("");
  }
}

function printLocks(repo: Repository, project: string | undefined, json: boolean) {
  const locks = repo.listLocks(project);
  if (json) {
    console.log(JSON.stringify(locks, null, 2));
    return;
  }
  if (locks.length === 0) {
    console.log("No active locks.");
    return;
  }
  console.log(`${locks.length} active lock(s):\n`);
  for (const l of locks) {
    const remaining = Math.max(0, Math.round((l.expires_at - Date.now()) / 1000));
    console.log(`  • ${l.resource}  (project: ${l.project})`);
    console.log(`    held by : ${l.session_id}${l.branch ? `  on ${l.branch}` : ""}`);
    if (l.reason) console.log(`    reason  : ${l.reason}`);
    console.log(`    since   : ${formatRelative(l.acquired_at)}`);
    console.log(`    expires : in ${remaining}s`);
    console.log("");
  }
}

function printHelp() {
  console.log(`claude-presence — inter-session coordination for Claude Code

Usage:
  claude-presence <command> [options]

Commands:
  status              Show active sessions (default)
  locks               Show active resource locks
  clear               Prune dead sessions and expired locks
  path                Print the SQLite database path
  help                Show this help

Options:
  --project <path>    Filter to a specific project
  --json              Output JSON instead of human-readable text
  --all               (clear) include inbox cleanup

Examples:
  claude-presence status
  claude-presence status --project /Volumes/DataIA/Projets/myapp
  claude-presence locks --json
  claude-presence clear --all
`);
}

async function main() {
  const { command, project, json, all } = parseArgs(process.argv);

  if (command === "help" || !COMMANDS.includes(command)) {
    printHelp();
    return;
  }

  if (command === "path") {
    console.log(getDefaultDbPath());
    return;
  }

  const db = openDatabase();
  const repo = new Repository(db);

  try {
    if (command === "status") {
      printStatus(repo, project, json);
    } else if (command === "locks") {
      printLocks(repo, project, json);
    } else if (command === "clear") {
      const sessions = repo.pruneDeadSessions();
      const locks = repo.pruneExpiredLocks();
      const inbox = all ? repo.pruneOldInbox() : 0;
      if (json) {
        console.log(
          JSON.stringify(
            { pruned_sessions: sessions, pruned_locks: locks, pruned_inbox: inbox },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `Pruned: ${sessions} dead session(s), ${locks} expired lock(s)${all ? `, ${inbox} old inbox message(s)` : ""}.`,
        );
      }
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("claude-presence:", err instanceof Error ? err.message : err);
  process.exit(1);
});

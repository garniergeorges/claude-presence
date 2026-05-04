#!/usr/bin/env node
import { openDatabase, getDefaultDbPath } from "../db/index.js";
import { Repository } from "../db/repository.js";

const COMMANDS = [
  "status",
  "locks",
  "inbox",
  "refresh-branch",
  "clear",
  "path",
  "help",
] as const;
type Command = (typeof COMMANDS)[number];

interface CliArgs {
  command: Command;
  project?: string;
  session?: string;
  branch?: string;
  minPriority?: "info" | "warning" | "urgent";
  json: boolean;
  all: boolean;
  unreadOnly: boolean;
  peek: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command = ((args[0] ?? "status") as Command);
  let project: string | undefined;
  let session: string | undefined;
  let branch: string | undefined;
  let minPriority: CliArgs["minPriority"];
  let json = false;
  let all = false;
  let unreadOnly = true;
  let peek = false;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--project" || a === "-p") {
      project = args[++i];
    } else if (a === "--session" || a === "-s") {
      session = args[++i];
    } else if (a === "--branch" || a === "-b") {
      branch = args[++i];
    } else if (a === "--min-priority") {
      const v = args[++i];
      if (v === "info" || v === "warning" || v === "urgent") minPriority = v;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--all") {
      all = true;
      // For inbox: --all means include already-read messages.
      // For clear: --all also enables inbox pruning. Same flag, different command.
      unreadOnly = false;
    } else if (a === "--peek") {
      peek = true;
    }
  }
  return {
    command,
    project,
    session,
    branch,
    minPriority,
    json,
    all,
    unreadOnly,
    peek,
  };
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

function printInbox(repo: Repository, args: CliArgs) {
  if (!args.session) {
    if (args.json) {
      console.log(JSON.stringify({ error: "missing --session <id>" }));
    } else {
      console.error("inbox requires --session <id>");
    }
    process.exit(1);
  }
  if (!args.project) {
    if (args.json) {
      console.log(JSON.stringify({ error: "missing --project <path>" }));
    } else {
      console.error("inbox requires --project <path>");
    }
    process.exit(1);
  }
  const result = repo.readInbox({
    project: args.project,
    session_id: args.session,
    unread_only: args.unreadOnly,
    peek: args.peek,
    min_priority: args.minPriority,
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.messages.length === 0) {
    console.log(args.unreadOnly ? "No new messages." : "No messages.");
    return;
  }
  console.log(
    `${result.messages.length} message(s)  [unread: ${result.unread_total}, total: ${result.total}]\n`,
  );
  for (const m of result.messages) {
    const target = m.to_session ? `→ ${m.to_session}` : "→ all";
    const tag = m.priority === "info" ? "" : `[${m.priority}] `;
    console.log(
      `  ${tag}${formatRelative(m.created_at)} from ${m.from_session}${m.from_branch ? ` (${m.from_branch})` : ""} ${target}`,
    );
    console.log(`    ${m.message}\n`);
  }
}

function printRefreshBranch(repo: Repository, args: CliArgs) {
  if (!args.session || !args.project || !args.branch) {
    const err = "refresh-branch requires --session, --project, --branch";
    if (args.json) {
      console.log(JSON.stringify({ error: err }));
    } else {
      console.error(err);
    }
    process.exit(1);
  }

  const existing = repo.getSession(args.session);
  if (!existing) {
    const result = { changed: false, reason: "session_not_found" as const };
    if (args.json) console.log(JSON.stringify(result));
    else console.log("Session not found; nothing to refresh.");
    return;
  }
  if (existing.project !== args.project) {
    const result = {
      changed: false,
      reason: "project_mismatch" as const,
      stored_project: existing.project,
    };
    if (args.json) console.log(JSON.stringify(result));
    else console.error(`Project mismatch (stored: ${existing.project}); skipping.`);
    return;
  }
  if (existing.branch === args.branch) {
    const result = { changed: false, branch: args.branch };
    if (args.json) console.log(JSON.stringify(result));
    else console.log(`Branch unchanged (${args.branch}).`);
    return;
  }

  repo.registerSession({
    id: args.session,
    project: existing.project,
    branch: args.branch,
    intent: existing.intent,
    pid: existing.pid,
    hostname: existing.hostname,
  });

  const result = {
    changed: true,
    from: existing.branch,
    to: args.branch,
  };
  if (args.json) console.log(JSON.stringify(result));
  else console.log(`Branch refreshed: ${existing.branch ?? "(none)"} → ${args.branch}.`);
}

function printHelp() {
  console.log(`claude-presence — inter-session coordination

Usage:
  claude-presence <command> [options]

Commands:
  status              Show active sessions (default)
  locks               Show active resource locks
  inbox               Read messages for a session (requires --session, --project)
  refresh-branch      Update a session's branch if it has drifted (requires --session, --project, --branch)
  clear               Prune dead sessions and expired locks
  path                Print the SQLite database path
  help                Show this help

Options:
  --project <path>    Filter to a specific project
  --session <id>      Session id (inbox, refresh-branch)
  --branch <name>     Current git branch (refresh-branch)
  --min-priority <p>  Filter inbox by min priority (info|warning|urgent)
  --peek              (inbox) Read without marking as read
  --json              Output JSON
  --all               (clear) include inbox cleanup; (inbox) include already-read

Examples:
  claude-presence status
  claude-presence locks --json
  claude-presence inbox --project /path/to/repo --session sess-A --peek --json
  claude-presence refresh-branch --project /path/to/repo --session sess-A --branch feat/foo
  claude-presence clear --all
`);
}

async function main() {
  const args = parseArgs(process.argv);
  const { command, project, json, all } = args;

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
    } else if (command === "inbox") {
      printInbox(repo, args);
    } else if (command === "refresh-branch") {
      printRefreshBranch(repo, args);
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

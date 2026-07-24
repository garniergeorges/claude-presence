#!/usr/bin/env node
import { hostname } from "node:os";
import { openDatabase, getDefaultDbPath } from "../db/index.js";
import { Repository } from "../db/repository.js";

const COMMANDS = [
  "status",
  "locks",
  "dashboard",
  "inbox",
  "refresh-branch",
  "resolve-session",
  "clear",
  "path",
  "help",
] as const;
type Command = (typeof COMMANDS)[number];

const WATCHABLE: Command[] = ["status", "locks", "dashboard"];

interface CliArgs {
  command: Command;
  project?: string;
  session?: string;
  branch?: string;
  client?: string;
  minPriority?: "info" | "warning" | "urgent";
  json: boolean;
  all: boolean;
  unreadOnly: boolean;
  peek: boolean;
  watch: boolean;
  interval: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command = ((args[0] ?? "status") as Command);
  let project: string | undefined;
  let session: string | undefined;
  let branch: string | undefined;
  let client: string | undefined;
  let minPriority: CliArgs["minPriority"];
  let json = false;
  let all = false;
  let unreadOnly = true;
  let peek = false;
  let watch = false;
  let interval = 5;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--project" || a === "-p") {
      project = args[++i];
    } else if (a === "--session" || a === "-s") {
      session = args[++i];
    } else if (a === "--branch" || a === "-b") {
      branch = args[++i];
    } else if (a === "--client" || a === "-c") {
      client = args[++i];
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
    } else if (a === "--watch" || a === "-w") {
      watch = true;
    } else if (a === "--interval") {
      const v = Number(args[++i]);
      if (Number.isFinite(v) && v >= 1) interval = Math.round(v);
    }
  }
  return {
    command,
    project,
    session,
    branch,
    client,
    minPriority,
    json,
    all,
    unreadOnly,
    peek,
    watch,
    interval,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pruneDeadPidSessions(repo: Repository): string[] {
  const host = hostname();
  const removed: string[] = [];
  for (const s of repo.listSessions()) {
    if (s.hostname === host && s.pid && !isPidAlive(s.pid)) {
      repo.unregisterSession(s.id);
      removed.push(s.id);
    }
  }
  return removed;
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
    console.log(`  • ${l.resource}  (project: ${l.project})${l.capacity > 1 ? `  [capacity ${l.capacity}]` : ""}`);
    console.log(`    held by : ${l.session_id}${l.branch ? `  on ${l.branch}` : ""}`);
    if (l.reason) console.log(`    reason  : ${l.reason}`);
    console.log(`    since   : ${formatRelative(l.acquired_at)}`);
    console.log(`    expires : in ${remaining}s`);
    console.log("");
  }
}

function printDashboard(repo: Repository, project: string | undefined, json: boolean) {
  const sessions = repo.listSessions(project);
  const locks = repo.listLocks(project);
  const projects = [
    ...new Set([...sessions.map((s) => s.project), ...locks.map((l) => l.project)]),
  ].sort();
  const data = projects.map((p) => ({
    project: p,
    sessions: sessions
      .filter((s) => s.project === p)
      .map((s) => ({
        id: s.id,
        branch: s.branch,
        intent: s.intent,
        last_heartbeat: s.last_heartbeat,
        unread: repo.readInbox({
          project: p,
          session_id: s.id,
          unread_only: true,
          peek: true,
          limit: 1,
        }).unread_total,
      })),
    locks: locks.filter((l) => l.project === p),
  }));

  if (json) {
    console.log(JSON.stringify({ projects: data }, null, 2));
    return;
  }
  if (data.length === 0) {
    console.log("Nothing to show: no active sessions or locks.");
    return;
  }
  for (const proj of data) {
    console.log(`Project ${proj.project}`);
    console.log(`  Sessions (${proj.sessions.length}):`);
    for (const s of proj.sessions) {
      const unread = s.unread > 0 ? `  [${s.unread} unread]` : "";
      console.log(
        `    • ${s.id}${s.branch ? `  on ${s.branch}` : ""}  (seen ${formatRelative(s.last_heartbeat)})${unread}`,
      );
      if (s.intent) console.log(`      intent: ${s.intent}`);
    }
    if (proj.locks.length > 0) {
      console.log(`  Locks (${proj.locks.length}):`);
      for (const l of proj.locks) {
        const remaining = Math.max(0, Math.round((l.expires_at - Date.now()) / 1000));
        console.log(
          `    • ${l.resource}  held by ${l.session_id}  (expires in ${remaining}s)${l.reason ? `  reason: ${l.reason}` : ""}`,
        );
      }
    }
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

  const sameBranch = repo
    .listSessions(existing.project)
    .filter((s) => s.id !== args.session && s.branch === args.branch)
    .map((s) => s.id);
  const result = {
    changed: true,
    from: existing.branch,
    to: args.branch,
    ...(sameBranch.length > 0 ? { same_branch: sameBranch } : {}),
  };
  if (args.json) console.log(JSON.stringify(result));
  else {
    console.log(`Branch refreshed: ${existing.branch ?? "(none)"} → ${args.branch}.`);
    if (sameBranch.length > 0) {
      console.log(`⚠️ Also on '${args.branch}': ${sameBranch.join(", ")}.`);
    }
  }
}

function printResolveSession(repo: Repository, args: CliArgs) {
  if (!args.client) {
    const err = "resolve-session requires --client <id>";
    if (args.json) {
      console.log(JSON.stringify({ error: err }));
    } else {
      console.error(err);
    }
    process.exit(1);
  }
  const row = repo.findByClientSessionId(args.client, args.project);
  const payload = row
    ? { session_id: row.id, project: row.project, branch: row.branch }
    : { session_id: null };
  if (args.json) {
    console.log(JSON.stringify(payload));
    return;
  }
  if (row) {
    console.log(row.id);
  } else {
    console.error("No session mapped to this client_session_id.");
    process.exit(2);
  }
}

function printHelp() {
  console.log(`claude-presence — inter-session coordination

Usage:
  claude-presence <command> [options]

Commands:
  status              Show active sessions (default)
  locks               Show active resource locks
  dashboard           Combined view: sessions, locks and unread counts per project
  inbox               Read messages for a session (requires --session, --project)
  refresh-branch      Update a session's branch if it has drifted (requires --session, --project, --branch)
  resolve-session     Resolve a client_session_id (e.g. \${CLAUDE_SESSION_ID}) to its registered session id (requires --client)
  clear               Prune dead sessions (TTL or dead local process) and expired locks;
                      with --session <id> or --client <id>, remove one session explicitly
  path                Print the SQLite database path
  help                Show this help

Options:
  --project <path>    Filter to a specific project
  --session <id>      Session id (inbox, refresh-branch, clear)
  --branch <name>     Current git branch (refresh-branch)
  --client <id>       Opaque client identifier (resolve-session, clear)
  --min-priority <p>  Filter inbox by min priority (info|warning|urgent)
  --peek              (inbox) Read without marking as read
  --json              Output JSON
  --all               (clear) include inbox cleanup; (inbox) include already-read
  --watch, -w         (status, locks, dashboard) refresh continuously in the terminal
  --interval <s>      Refresh period for --watch, in seconds (default 5)

Examples:
  claude-presence status
  claude-presence locks --json
  claude-presence dashboard --watch --interval 10
  claude-presence inbox --project /path/to/repo --session sess-A --peek --json
  claude-presence refresh-branch --project /path/to/repo --session sess-A --branch feat/foo
  claude-presence resolve-session --client \$CLAUDE_SESSION_ID --project /path/to/repo --json
  claude-presence clear --all
  claude-presence clear --session sess-A
  claude-presence clear --client \$CLAUDE_SESSION_ID
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
    if (args.watch && WATCHABLE.includes(command)) {
      if (json) {
        console.error("--watch cannot be combined with --json");
        process.exit(1);
      }
      for (;;) {
        console.clear();
        console.log(
          `claude-presence ${command} — refresh every ${args.interval}s, Ctrl+C to quit\n`,
        );
        if (command === "status") printStatus(repo, project, false);
        else if (command === "locks") printLocks(repo, project, false);
        else printDashboard(repo, project, false);
        await new Promise((r) => setTimeout(r, args.interval * 1000));
      }
    }

    if (command === "status") {
      printStatus(repo, project, json);
    } else if (command === "locks") {
      printLocks(repo, project, json);
    } else if (command === "dashboard") {
      printDashboard(repo, project, json);
    } else if (command === "inbox") {
      printInbox(repo, args);
    } else if (command === "refresh-branch") {
      printRefreshBranch(repo, args);
    } else if (command === "resolve-session") {
      printResolveSession(repo, args);
    } else if (command === "clear") {
      if (args.session || args.client) {
        const result = args.session
          ? repo.unregisterSession(args.session)
          : repo.unregisterByClientSessionId(args.client!);
        if (json) {
          console.log(JSON.stringify(result));
        } else if (result.removed) {
          const removedId =
            "session_id" in result ? result.session_id : args.session;
          console.log(`Removed session '${removedId}'.`);
        } else {
          console.error("Session not found; nothing removed.");
          process.exitCode = 2;
        }
        return;
      }
      const sessions = repo.pruneDeadSessions();
      const deadPid = pruneDeadPidSessions(repo);
      const locks = repo.pruneExpiredLocks();
      const inbox = all ? repo.pruneOldInbox() : 0;
      if (json) {
        console.log(
          JSON.stringify(
            {
              pruned_sessions: sessions,
              pruned_dead_pid_sessions: deadPid,
              pruned_locks: locks,
              pruned_inbox: inbox,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `Pruned: ${sessions} dead session(s), ${deadPid.length} dead-process session(s), ${locks} expired lock(s)${all ? `, ${inbox} old inbox message(s)` : ""}.`,
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

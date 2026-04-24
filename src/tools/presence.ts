import { z } from "zod";
import type { Repository } from "../db/repository.js";
import { formatSession, type McpTool } from "./helpers.js";

export function presenceTools(repo: Repository): McpTool[] {
  return [
    {
      name: "session_register",
      description:
        "Register this Claude Code session in the local presence registry. Call this at session start so other sessions can see you. Returns your session id (use it for heartbeats and locks).",
      inputShape: {
        session_id: z
          .string()
          .min(1)
          .describe(
            "Unique id for this session. Use Claude Code's session id if available, else any stable string.",
          ),
        project: z
          .string()
          .min(1)
          .describe("Absolute path or canonical name of the project/repo."),
        branch: z.string().optional().describe("Git branch you're working on."),
        intent: z
          .string()
          .optional()
          .describe(
            "Short human-readable description of what you're doing (e.g. 'fixing auth bug', 'refactoring API').",
          ),
        pid: z.number().int().optional().describe("Your process PID."),
        hostname: z.string().optional().describe("Machine hostname."),
      },
      handler: async (args) => {
        const row = repo.registerSession({
          id: args.session_id,
          project: args.project,
          branch: args.branch ?? null,
          intent: args.intent ?? null,
          pid: args.pid ?? null,
          hostname: args.hostname ?? null,
        });
        const others = repo
          .listSessions(args.project)
          .filter((s) => s.id !== args.session_id);
        return {
          registered: formatSession(row),
          other_sessions_on_same_project: others.map(formatSession),
          advice:
            others.length > 0
              ? `⚠️ ${others.length} other session(s) active on this project. Check session_list / resource_list before making shared changes.`
              : "No other sessions currently active on this project.",
        };
      },
    },
    {
      name: "session_heartbeat",
      description:
        "Refresh this session's last-seen timestamp. Call periodically (at most every 30s) so the session isn't pruned as dead (TTL: 2 min).",
      inputShape: {
        session_id: z.string().min(1),
      },
      handler: async (args) => {
        const ok = repo.heartbeat(args.session_id);
        return { ok, at: new Date().toISOString() };
      },
    },
    {
      name: "session_unregister",
      description:
        "Cleanly remove this session from the registry (also releases any locks it held).",
      inputShape: {
        session_id: z.string().min(1),
      },
      handler: async (args) => {
        const removed = repo.unregisterSession(args.session_id);
        return { removed };
      },
    },
    {
      name: "session_list",
      description:
        "List active sessions. By default limited to the given project. Dead sessions (no heartbeat for 2 min) are pruned automatically.",
      inputShape: {
        project: z
          .string()
          .optional()
          .describe(
            "Filter to this project. Omit to list all sessions everywhere.",
          ),
        exclude_session_id: z
          .string()
          .optional()
          .describe("Your own session id, to exclude yourself from results."),
      },
      handler: async (args) => {
        let sessions = repo.listSessions(args.project);
        if (args.exclude_session_id) {
          sessions = sessions.filter((s) => s.id !== args.exclude_session_id);
        }
        return {
          count: sessions.length,
          sessions: sessions.map(formatSession),
        };
      },
    },
  ];
}

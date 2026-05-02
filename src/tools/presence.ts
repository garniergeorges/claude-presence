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
        "Refresh this session's last-seen timestamp. Sessions are kept for 24 hours without a heartbeat before being pruned, so periodic heartbeats are only required if you want to mark the session as recently active. If the session was already pruned, supply the optional recreate_* fields to have the server silently re-register it.",
      inputShape: {
        session_id: z.string().min(1),
        recreate_project: z
          .string()
          .optional()
          .describe(
            "If provided along with recreate_* fields, auto-recreate the session when it has been pruned.",
          ),
        recreate_branch: z.string().optional(),
        recreate_intent: z.string().optional(),
      },
      handler: async (args) => {
        const recreateWith = args.recreate_project
          ? {
              id: args.session_id,
              project: args.recreate_project,
              branch: args.recreate_branch ?? null,
              intent: args.recreate_intent ?? null,
            }
          : undefined;
        const result = repo.heartbeat(args.session_id, recreateWith);
        return { ...result, at: new Date().toISOString() };
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
        return repo.unregisterSession(args.session_id);
      },
    },
    {
      name: "session_list",
      description:
        "List active sessions. By default limited to the given project. Sessions with no heartbeat for 24 hours are pruned automatically when the list is requested.",
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

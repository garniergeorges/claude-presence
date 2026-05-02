import { z } from "zod";
import type { Repository } from "../db/repository.js";
import { formatInbox, type McpTool } from "./helpers.js";

const PRIORITY_VALUES = ["info", "warning", "urgent"] as const;

export function inboxTools(repo: Repository): McpTool[] {
  return [
    {
      name: "broadcast",
      description:
        "Post a message to the project inbox. By default broadcasts to every session on the project; set to_session to address one session privately. priority controls automatic surfacing on other sessions: 'warning' and 'urgent' are injected on each prompt without requiring read_inbox.",
      inputShape: {
        session_id: z.string().min(1),
        project: z.string().min(1),
        from_branch: z.string().optional(),
        to_session: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Target one session by id. Omit for a project-wide broadcast.",
          ),
        priority: z
          .enum(PRIORITY_VALUES)
          .optional()
          .default("info")
          .describe(
            "info (default): silent until /inbox. warning/urgent: surfaced automatically on other sessions' next prompt.",
          ),
        message: z.string().min(1).max(2000),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Optional tags for filtering (e.g. ['ci', 'refactor']).",
          ),
      },
      handler: async (args) => {
        const row = repo.broadcast({
          project: args.project,
          from_session: args.session_id,
          from_branch: args.from_branch ?? null,
          to_session: args.to_session ?? null,
          priority: args.priority ?? "info",
          message: args.message,
          tags: args.tags ?? null,
        });
        return { posted: formatInbox(row) };
      },
    },
    {
      name: "read_inbox",
      description:
        "Read messages addressed to this session — direct messages (to_session = me) plus project-wide broadcasts. Own posts are excluded. By default returns unread only and marks them read; pass peek: true to look without marking.",
      inputShape: {
        session_id: z.string().min(1),
        project: z.string().min(1),
        unread_only: z
          .boolean()
          .optional()
          .default(true)
          .describe("Default true: only return messages you haven't seen yet."),
        peek: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Default false. When true, do not mark returned messages as read.",
          ),
        min_priority: z
          .enum(PRIORITY_VALUES)
          .optional()
          .describe(
            "Filter to messages at or above this priority. Omit for all.",
          ),
        limit: z.number().int().positive().max(200).optional().default(50),
      },
      handler: async (args) => {
        const result = repo.readInbox({
          project: args.project,
          session_id: args.session_id,
          unread_only: args.unread_only,
          peek: args.peek,
          min_priority: args.min_priority,
          limit: args.limit,
        });
        return {
          count: result.messages.length,
          unread_total: result.unread_total,
          total: result.total,
          messages: result.messages.map(formatInbox),
        };
      },
    },
  ];
}

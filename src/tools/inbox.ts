import { z } from "zod";
import type { Repository } from "../db/repository.js";
import { formatInbox, type McpTool } from "./helpers.js";

const PRIORITY_VALUES = ["info", "warning", "urgent"] as const;

export function inboxTools(repo: Repository): McpTool[] {
  return [
    {
      name: "broadcast",
      description:
        "Post a message to the project inbox. By default broadcasts to every session on the project; set to_session to address one session privately. priority controls automatic surfacing on other sessions: 'warning' and 'urgent' are injected on each prompt without requiring read_inbox. The server stamps from_identity from your auth token — it cannot be forged from arguments. Optional act/cid/fim/rt promote the C2C envelope into queryable fields.",
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
        act: z
          .string()
          .max(32)
          .optional()
          .describe(
            "Structured envelope: message act (e.g. ASK, PROPOSE, AGREE, COMMIT, INFO, ERR, WAKE). Queryable via read_inbox filters.",
          ),
        cid: z
          .string()
          .max(64)
          .optional()
          .describe(
            "Structured envelope: conversation/room id (e.g. c-20260803-6c95).",
          ),
        fim: z
          .boolean()
          .optional()
          .describe(
            "Structured envelope: true closes the turn — the peer should not reply.",
          ),
        rt: z
          .string()
          .max(64)
          .optional()
          .describe("Structured envelope: id of the message this replies to."),
      },
      handler: async (args, meta) => {
        const row = repo.broadcast({
          project: args.project,
          from_session: args.session_id,
          from_branch: args.from_branch ?? null,
          to_session: args.to_session ?? null,
          priority: args.priority ?? "info",
          message: args.message,
          tags: args.tags ?? null,
          from_identity: meta?.identity ?? null,
          act: args.act ?? null,
          cid: args.cid ?? null,
          fim: args.fim ?? null,
          rt: args.rt ?? null,
        });
        return { posted: formatInbox(row) };
      },
    },
    {
      name: "read_inbox",
      description:
        "Read messages addressed to this session — direct messages (to_session = me) plus project-wide broadcasts. Own posts are excluded. By default returns unread only and marks them read; pass peek: true to look without marking. since_id turns the call into a cursor read: only messages with id > since_id, ascending, plus max_id to advance the cursor even on silence — the reliable way for pollers to survive restarts without losing the dead window.",
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
        since_id: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Cursor: only messages with id > since_id, ordered ascending. Persist max_id from the response and pass it back here — dedup becomes server-authoritative.",
          ),
        act: z
          .string()
          .max(32)
          .optional()
          .describe("Filter to messages whose envelope act equals this."),
        cid: z
          .string()
          .max(64)
          .optional()
          .describe("Filter to messages of this conversation/room id."),
        fim: z
          .boolean()
          .optional()
          .describe(
            "Filter by turn-closing flag (e.g. fim: false = messages still awaiting a reply).",
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
          since_id: args.since_id,
          act: args.act,
          cid: args.cid,
          fim: args.fim,
          limit: args.limit,
        });
        return {
          count: result.messages.length,
          unread_total: result.unread_total,
          total: result.total,
          max_id: result.max_id,
          messages: result.messages.map(formatInbox),
        };
      },
    },
  ];
}

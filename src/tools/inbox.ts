import { z } from "zod";
import type { Repository } from "../db/repository.js";
import { formatInbox, type McpTool } from "./helpers.js";

export function inboxTools(repo: Repository): McpTool[] {
  return [
    {
      name: "broadcast",
      description:
        "Post a short message to the project-wide inbox so other sessions on the same project can see it. Use for heads-ups like 'refactored auth module, watch for merge conflicts' or 'about to run long migration on staging'. Keep it short.",
      inputShape: {
        session_id: z.string().min(1),
        project: z.string().min(1),
        from_branch: z.string().optional(),
        message: z.string().min(1).max(2000),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Optional tags for filtering (e.g. ['warning', 'ci', 'refactor']).",
          ),
      },
      handler: async (args) => {
        const row = repo.broadcast({
          project: args.project,
          from_session: args.session_id,
          from_branch: args.from_branch ?? null,
          message: args.message,
          tags: args.tags ?? null,
        });
        return { posted: formatInbox(row) };
      },
    },
    {
      name: "read_inbox",
      description:
        "Read recent broadcasts from other sessions on this project. Messages from your own session are excluded. By default returns unread messages only.",
      inputShape: {
        session_id: z.string().min(1),
        project: z.string().min(1),
        unread_only: z
          .boolean()
          .optional()
          .default(true)
          .describe("Default true: only return messages you haven't seen yet."),
        limit: z.number().int().positive().max(200).optional().default(50),
      },
      handler: async (args) => {
        const rows = repo.readInbox({
          project: args.project,
          session_id: args.session_id,
          unread_only: args.unread_only,
          limit: args.limit,
        });
        return {
          count: rows.length,
          messages: rows.map(formatInbox),
        };
      },
    },
  ];
}

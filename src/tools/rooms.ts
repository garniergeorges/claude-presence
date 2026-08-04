import { z } from "zod";
import type { Repository } from "../db/repository.js";
import type { McpTool } from "./helpers.js";

/**
 * Room lifecycle. A "room" is just a project key (the C2C protocol uses
 * per-conversation projects like "c2c/joao-matheus#c-20260803-6c95").
 * Closing makes the FIM semantics server-enforced: no new broadcasts, no new
 * registrations, ghost sessions dropped. Messages stay readable (drain) until
 * the normal retention prune removes them.
 */
export function roomTools(repo: Repository): McpTool[] {
  return [
    {
      name: "project_close",
      description:
        "Close a project/room: refuses new broadcasts and session registrations, removes its sessions and locks. Read access is kept so late pollers can drain. Idempotent. Use when a conversation ends (e.g. C2C fim:true) so rooms stop accumulating ghost sessions.",
      inputShape: {
        session_id: z.string().min(1).describe("Who is closing (recorded)."),
        project: z.string().min(1).describe("The project/room key to close."),
        reason: z
          .string()
          .max(500)
          .optional()
          .describe("Why it's being closed (e.g. 'fim received, sala encerrada')."),
      },
      handler: async (args, meta) => {
        const result = repo.closeProject({
          project: args.project,
          closed_by: args.session_id,
          closed_identity: meta?.identity ?? null,
          reason: args.reason ?? null,
        });
        return {
          ...result,
          project: args.project,
          advice: result.already_closed
            ? "Project was already closed; nothing changed."
            : "Project closed. New broadcasts/registrations will be refused; read_inbox still drains.",
        };
      },
    },
    {
      name: "project_reopen",
      description:
        "Reopen a previously closed project/room, allowing broadcasts and registrations again.",
      inputShape: {
        session_id: z.string().min(1),
        project: z.string().min(1),
      },
      handler: async (args) => {
        const result = repo.reopenProject(args.project);
        return { ...result, project: args.project };
      },
    },
  ];
}

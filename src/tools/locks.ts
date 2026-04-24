import { z } from "zod";
import type { Repository } from "../db/repository.js";
import { formatLock, type McpTool } from "./helpers.js";

export function lockTools(repo: Repository): McpTool[] {
  return [
    {
      name: "resource_claim",
      description:
        "Try to acquire an advisory lock on a named shared resource. Use before touching anything that other sessions might also touch: CI ('ci'), deployments ('deploy:staging'), ports ('port:3000'), shared DBs ('db:staging'), etc. The lock is advisory — other sessions can still act, but they'll see your claim. If another session already holds it, returns ok=false with the holder info so you can decide to wait or coordinate.",
      inputShape: {
        session_id: z.string().min(1),
        project: z.string().min(1),
        resource: z
          .string()
          .min(1)
          .describe(
            "Arbitrary string naming the resource. Examples: 'ci', 'deploy:production', 'port:3000', 'db:staging'. Scoped per project.",
          ),
        branch: z.string().optional(),
        reason: z
          .string()
          .optional()
          .describe("Short description of why you need this resource."),
        ttl_seconds: z
          .number()
          .int()
          .positive()
          .max(24 * 3600)
          .optional()
          .describe("How long the lock stays valid without renewal. Default 600 (10 min), max 86400 (24h)."),
      },
      handler: async (args) => {
        const result = repo.claimResource({
          resource: args.resource,
          project: args.project,
          session_id: args.session_id,
          branch: args.branch ?? null,
          reason: args.reason ?? null,
          ttl_seconds: args.ttl_seconds,
        });

        if (!result.ok && result.held_by) {
          const holder = result.held_by;
          const heldBySession = repo.getSession(holder.session_id);
          return {
            ok: false,
            message: `Resource '${args.resource}' is already claimed by another session. Consider waiting, coordinating via broadcast, or asking the user before proceeding.`,
            held_by: formatLock(holder),
            holder_session: heldBySession
              ? {
                  id: heldBySession.id,
                  branch: heldBySession.branch,
                  intent: heldBySession.intent,
                }
              : null,
          };
        }

        return {
          ok: true,
          message: `Lock acquired on '${args.resource}'. Remember to resource_release when done.`,
          lock: formatLock(result.lock!),
        };
      },
    },
    {
      name: "resource_release",
      description:
        "Release an advisory lock you hold on a resource. Call this as soon as the operation finishes (CI done, deploy done) so others can proceed.",
      inputShape: {
        session_id: z.string().min(1),
        project: z.string().min(1),
        resource: z.string().min(1),
        force: z
          .boolean()
          .optional()
          .describe(
            "Force-release even if you're not the holder. Use only if you're cleaning up after a dead session.",
          ),
      },
      handler: async (args) => {
        const result = repo.releaseResource({
          resource: args.resource,
          project: args.project,
          session_id: args.session_id,
          force: args.force,
        });
        return result;
      },
    },
    {
      name: "resource_list",
      description:
        "List active resource locks. Useful to understand what shared resources are currently claimed before attempting shared operations.",
      inputShape: {
        project: z
          .string()
          .optional()
          .describe("Filter to this project. Omit for all."),
      },
      handler: async (args) => {
        const locks = repo.listLocks(args.project);
        return {
          count: locks.length,
          locks: locks.map(formatLock),
        };
      },
    },
  ];
}

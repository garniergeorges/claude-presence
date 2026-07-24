import { z } from "zod";
import type { Repository } from "../db/repository.js";
import { formatLock, type McpTool } from "./helpers.js";

export function lockTools(repo: Repository): McpTool[] {
  return [
    {
      name: "resource_claim",
      description:
        "Try to acquire an advisory lock on a named shared resource. Use before touching anything that other sessions might also touch: CI ('ci'), deployments ('deploy:staging'), ports ('port:3000'), shared DBs ('db:staging'), etc. The lock is advisory — other sessions can still act, but they'll see your claim. With capacity > 1 the resource behaves as a counted lock (semaphore): up to that many sessions hold a slot concurrently, e.g. throttling CPU-heavy jobs ('cpu-heavy'). If the resource is at capacity, returns ok=false with the holder info so you can decide to wait or coordinate.",
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
        wait: z
          .boolean()
          .optional()
          .describe(
            "If the resource is already claimed, join the waiting queue. One waiter is notified via inbox (surfaced at the next prompt) per freed slot when a lock is released or expires.",
          ),
        capacity: z
          .number()
          .int()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "Semaphore capacity: max concurrent holders for this resource. Only takes effect when the resource is currently free; while held, the capacity set by the first holder applies (release every slot to change it). Default 1 (exclusive lock).",
          ),
      },
      handler: async (args) => {
        const result = repo.claimResource({
          resource: args.resource,
          project: args.project,
          session_id: args.session_id,
          branch: args.branch ?? null,
          reason: args.reason ?? null,
          ttl_seconds: args.ttl_seconds,
          wait: args.wait,
          capacity: args.capacity,
        });

        if (!result.ok && result.held_by) {
          const holder = result.held_by;
          const heldBySession = repo.getSession(holder.session_id);
          const cap = result.capacity ?? 1;
          const atCapacity =
            cap > 1
              ? `Resource '${args.resource}' is at capacity (${result.holders!.length}/${cap} slots in use).`
              : `Resource '${args.resource}' is already claimed by another session.`;
          return {
            ok: false,
            message: result.queued
              ? `${atCapacity} You are #${result.queue_position} in the waiting queue and will get an inbox notification when a slot frees up.`
              : `${atCapacity} Consider retrying with wait=true to join the queue, coordinating via broadcast, or asking the user before proceeding.`,
            held_by: formatLock(holder),
            ...(cap > 1 ? { holders: result.holders!.map(formatLock) } : {}),
            capacity: cap,
            holder_session: heldBySession
              ? {
                  id: heldBySession.id,
                  branch: heldBySession.branch,
                  intent: heldBySession.intent,
                }
              : null,
            ...(result.queued
              ? { queued: true, queue_position: result.queue_position }
              : {}),
            ...(result.session_recreated
              ? { session_recreated: true }
              : {}),
          };
        }

        const cap = result.capacity ?? 1;
        const acquired =
          cap > 1
            ? `Slot acquired on '${args.resource}' (capacity ${cap}).`
            : `Lock acquired on '${args.resource}'.`;
        return {
          ok: true,
          message: result.session_recreated
            ? `${acquired} Note: your session had been pruned (TTL expired) and was silently re-registered — consider keeping a regular session_heartbeat.`
            : `${acquired} Remember to resource_release when done.`,
          lock: formatLock(result.lock!),
          capacity: cap,
          ...(result.session_recreated ? { session_recreated: true } : {}),
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
            "Force-release even if you're not a holder: clears every slot of the resource. Use only if you're cleaning up after dead sessions.",
          ),
      },
      handler: async (args) => {
        const result = repo.releaseResource({
          resource: args.resource,
          project: args.project,
          session_id: args.session_id,
          force: args.force,
        });
        if (result.released && result.notified_waiter) {
          const who = result.notified_waiters ?? [result.notified_waiter];
          return {
            ...result,
            message: `Waiting session(s) ${who.map((w) => `'${w}'`).join(", ")} notified that a slot is free.`,
          };
        }
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
          locks: locks.map((lock) => {
            const waiters = repo.getWaiters(lock.project, lock.resource);
            return {
              ...formatLock(lock),
              ...(waiters.length > 0
                ? { waiting: waiters.map((w) => w.session_id) }
                : {}),
            };
          }),
        };
      },
    },
  ];
}

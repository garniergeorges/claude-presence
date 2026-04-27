import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Repository } from "../db/repository.js";
import { allTools } from "../tools/registry.js";
import type { McpTool } from "../tools/helpers.js";
import { canCallTool, canForceRelease, type TokenPermissions } from "./rbac.js";
import type { AuditLogger } from "./audit.js";

export interface GuardedToolContext {
  permissions: TokenPermissions;
  tokenId: string | null;
  ipAddress: string | null;
  audit: AuditLogger;
}

/**
 * Registers all MCP tools wrapped with permission checks.
 * Each call evaluates the active token's scope and tool overrides.
 *
 * The guarded tools rely on a per-server-session context. The transport
 * layer must populate `getContext()` before each request handling.
 */
export function registerGuardedTools(
  server: McpServer,
  repo: Repository,
  getContext: () => GuardedToolContext | null,
): McpTool[] {
  const tools = allTools(repo);

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
      },
      async (args: unknown): Promise<CallToolResult> => {
        const ctx = getContext();
        const start = Date.now();

        // Stateless mode (no auth context) — fall through, used by tests
        if (!ctx) {
          return invokeTool(tool, args, () => undefined);
        }

        if (!canCallTool(ctx.permissions, tool.name)) {
          ctx.audit.log({
            tokenId: ctx.tokenId,
            toolName: tool.name,
            args,
            status: "denied",
            ipAddress: ctx.ipAddress,
            durationMs: Date.now() - start,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "permission_denied",
                    tool: tool.name,
                    scope: ctx.permissions.scope,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        // Special-case: refuse force=true on resource_release for non-admin
        if (
          tool.name === "resource_release" &&
          isObject(args) &&
          (args as { force?: boolean }).force === true &&
          !canForceRelease(ctx.permissions)
        ) {
          ctx.audit.log({
            tokenId: ctx.tokenId,
            toolName: tool.name,
            args,
            status: "denied",
            ipAddress: ctx.ipAddress,
            durationMs: Date.now() - start,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "force_release_requires_admin",
                    scope: ctx.permissions.scope,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        return invokeTool(tool, args, (status) => {
          ctx.audit.log({
            tokenId: ctx.tokenId,
            toolName: tool.name,
            args,
            status,
            ipAddress: ctx.ipAddress,
            durationMs: Date.now() - start,
          });
        });
      },
    );
  }

  return tools;
}

async function invokeTool(
  tool: McpTool,
  args: unknown,
  reportStatus: (status: "ok" | "error") => void,
): Promise<CallToolResult> {
  try {
    const result = await tool.handler(args as never);
    reportStatus("ok");
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportStatus("error");
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: message }, null, 2) },
      ],
      isError: true,
    };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

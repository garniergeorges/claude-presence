import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Repository } from "../db/repository.js";
import { presenceTools } from "./presence.js";
import { lockTools } from "./locks.js";
import { inboxTools } from "./inbox.js";
import type { McpTool } from "./helpers.js";

export function allTools(repo: Repository): McpTool[] {
  return [
    ...presenceTools(repo),
    ...lockTools(repo),
    ...inboxTools(repo),
  ];
}

export function registerAllTools(server: McpServer, repo: Repository): McpTool[] {
  const tools = allTools(repo);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const result = await tool.handler(args as never);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: message }, null, 2) },
            ],
            isError: true,
          };
        }
      },
    );
  }
  return tools;
}

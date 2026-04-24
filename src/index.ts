#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "./db/index.js";
import { Repository } from "./db/repository.js";
import { presenceTools } from "./tools/presence.js";
import { lockTools } from "./tools/locks.js";
import { inboxTools } from "./tools/inbox.js";
import type { McpTool } from "./tools/helpers.js";

const PACKAGE_NAME = "claude-presence";
const PACKAGE_VERSION = "0.1.0";

const SERVER_INSTRUCTIONS = `
This server coordinates multiple Claude Code sessions running in parallel on the same machine.

At session start, call session_register with a stable session_id and the project path.
The tool response will tell you if other sessions are currently active on the same project.

Before touching shared resources (CI, deploys, ports, staging DBs), try resource_claim
with a descriptive resource name. If ok=false, another session holds it — decide whether
to wait, coordinate via broadcast, or ask the user.

Call session_heartbeat periodically (every 30-60s) so you aren't pruned as dead (2 min TTL).
Call session_unregister on clean exit.

The data is stored locally in SQLite (~/.claude-presence/state.db).
No network, no daemon, no telemetry.
`.trim();

async function main() {
  const db = openDatabase();
  const repo = new Repository(db);
  repo.pruneAll();

  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const allTools: McpTool[] = [
    ...presenceTools(repo),
    ...lockTools(repo),
    ...inboxTools(repo),
  ];

  for (const tool of allTools) {
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
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: message }, null, 2),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(
    `[${PACKAGE_NAME}] v${PACKAGE_VERSION} ready on stdio — ${allTools.length} tools registered`,
  );
}

main().catch((err) => {
  console.error(`[${PACKAGE_NAME}] fatal:`, err);
  process.exit(1);
});

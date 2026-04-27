export type Scope = "read" | "write" | "admin";

export const ALL_TOOLS = [
  "session_register",
  "session_heartbeat",
  "session_unregister",
  "session_list",
  "resource_claim",
  "resource_release",
  "resource_list",
  "broadcast",
  "read_inbox",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];

const READ_TOOLS: ToolName[] = [
  "session_list",
  "session_heartbeat",
  "resource_list",
  "read_inbox",
];

const WRITE_TOOLS: ToolName[] = [
  ...READ_TOOLS,
  "session_register",
  "session_unregister",
  "resource_claim",
  "resource_release",
  "broadcast",
];

const ADMIN_TOOLS: ToolName[] = [...WRITE_TOOLS];

export const SCOPE_TOOLS: Record<Scope, ToolName[]> = {
  read: READ_TOOLS,
  write: WRITE_TOOLS,
  admin: ADMIN_TOOLS,
};

export interface TokenPermissions {
  scope: Scope;
  toolOverrides?: ToolName[] | null;
}

/**
 * Resolves the effective set of tools a token can call.
 * If toolOverrides is set, it REPLACES the scope's default list (intersection
 * with the scope, so a "read" token cannot escalate to write tools via override).
 */
export function effectiveTools(perms: TokenPermissions): ToolName[] {
  const scopeTools = SCOPE_TOOLS[perms.scope];
  if (!perms.toolOverrides || perms.toolOverrides.length === 0) {
    return scopeTools;
  }
  return perms.toolOverrides.filter((t) => scopeTools.includes(t));
}

export function canCallTool(perms: TokenPermissions, tool: string): boolean {
  if (!ALL_TOOLS.includes(tool as ToolName)) return false;
  return effectiveTools(perms).includes(tool as ToolName);
}

/**
 * Admin scope unlocks the `force: true` parameter on resource_release.
 * Other scopes are silently denied even if they pass force=true.
 */
export function canForceRelease(perms: TokenPermissions): boolean {
  return perms.scope === "admin";
}

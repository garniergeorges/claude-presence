import { openDatabase } from "../db/index.js";
import { TokenStore } from "../auth/tokens.js";
import { ALL_TOOLS, type Scope, type ToolName } from "../auth/rbac.js";

interface CreateArgs {
  name: string;
  scope: Scope;
  toolOverrides?: ToolName[];
  notes?: string;
}

const VALID_SCOPES: Scope[] = ["read", "write", "admin"];

function parseCreateArgs(args: string[]): CreateArgs {
  let name: string | undefined;
  let scope: Scope | undefined;
  let toolOverrides: ToolName[] | undefined;
  let notes: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--name") name = args[++i];
    else if (a === "--scope") {
      const s = args[++i];
      if (!VALID_SCOPES.includes(s as Scope)) {
        die(`Invalid scope "${s}". Must be one of: ${VALID_SCOPES.join(", ")}`);
      }
      scope = s as Scope;
    } else if (a === "--tools") {
      const list = args[++i].split(",").map((t) => t.trim()) as ToolName[];
      const invalid = list.filter((t) => !(ALL_TOOLS as readonly string[]).includes(t));
      if (invalid.length > 0) {
        die(`Unknown tool(s): ${invalid.join(", ")}. Valid: ${ALL_TOOLS.join(", ")}`);
      }
      toolOverrides = list;
    } else if (a === "--notes") notes = args[++i];
  }

  if (!name) die("Missing --name");
  if (!scope) die("Missing --scope (read|write|admin)");

  return { name: name!, scope: scope!, toolOverrides, notes };
}

function die(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function formatRelative(ms: number | null): string {
  if (ms === null) return "never";
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export async function runTokenCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "create":
      return tokenCreate(rest);
    case "list":
      return tokenList();
    case "revoke":
      return tokenRevoke(rest);
    case "show":
      return tokenShow(rest);
    case "help":
    case "--help":
    case undefined:
      printHelp();
      return;
    default:
      die(`Unknown token sub-command: ${sub}. Run "token help" for usage.`);
  }
}

function printHelp(): void {
  console.log(`claude-presence-server token <command>

Commands:
  create --name <n> --scope <read|write|admin> [--tools t1,t2,...] [--notes "..."]
                          Create a new bearer token. Prints the token ONCE.
  list                    List all tokens (active and revoked).
  revoke --name <n>       Revoke a token by name.
  show --name <n>         Show details for a token.
  help                    Show this help.

Tools available for --tools (overrides the scope's default tool set):
  ${ALL_TOOLS.join(", ")}
`);
}

async function tokenCreate(args: string[]): Promise<void> {
  const parsed = parseCreateArgs(args);
  const db = openDatabase();
  const store = new TokenStore(db);

  if (store.findByName(parsed.name)) {
    die(`A token named "${parsed.name}" already exists.`);
  }

  const created = store.create({
    name: parsed.name,
    scope: parsed.scope,
    toolOverrides: parsed.toolOverrides,
    notes: parsed.notes,
  });

  console.log("");
  console.log(`Token created.`);
  console.log("");
  console.log(`  name  : ${created.name}`);
  console.log(`  scope : ${created.scope}`);
  console.log(`  id    : ${created.id}`);
  console.log("");
  console.log(`  ${created.plaintextToken}`);
  console.log("");
  console.log(`This token is shown ONCE. Save it now; the server only stores its hash.`);
  console.log("");

  db.close();
}

async function tokenList(): Promise<void> {
  const db = openDatabase();
  const store = new TokenStore(db);
  const rows = store.list();

  if (rows.length === 0) {
    console.log("No tokens.");
    db.close();
    return;
  }

  console.log("");
  console.log("name".padEnd(20) + "scope".padEnd(10) + "status".padEnd(12) + "created".padEnd(15) + "last used");
  console.log("-".repeat(80));
  for (const r of rows) {
    const status = r.revoked_at !== null ? "revoked" : "active";
    console.log(
      r.name.padEnd(20) +
        r.scope.padEnd(10) +
        status.padEnd(12) +
        formatRelative(r.created_at).padEnd(15) +
        formatRelative(r.last_used_at),
    );
  }
  console.log("");

  db.close();
}

async function tokenRevoke(args: string[]): Promise<void> {
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") name = args[++i];
  }
  if (!name) die("Missing --name");

  const db = openDatabase();
  const store = new TokenStore(db);
  const result = store.revoke(name!);
  db.close();

  if (result.revoked) {
    console.log(`Token "${name}" revoked. Future requests with this token will return 401.`);
    return;
  }
  if (result.reason === "not_found") {
    die(`No token named "${name}".`);
  }
  if (result.reason === "already_revoked") {
    console.log(`Token "${name}" was already revoked.`);
    return;
  }
}

async function tokenShow(args: string[]): Promise<void> {
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") name = args[++i];
  }
  if (!name) die("Missing --name");

  const db = openDatabase();
  const store = new TokenStore(db);
  const row = store.findByName(name!);
  db.close();

  if (!row) {
    die(`No token named "${name}".`);
  }

  console.log("");
  console.log(`  name           : ${row!.name}`);
  console.log(`  id             : ${row!.id}`);
  console.log(`  scope          : ${row!.scope}`);
  console.log(`  tool_overrides : ${row!.tool_overrides ?? "(none)"}`);
  console.log(`  created        : ${new Date(row!.created_at).toISOString()}`);
  console.log(`  last_used      : ${row!.last_used_at ? new Date(row!.last_used_at).toISOString() : "never"}`);
  console.log(`  revoked        : ${row!.revoked_at ? new Date(row!.revoked_at).toISOString() : "no"}`);
  console.log(`  notes          : ${row!.notes ?? "(none)"}`);
  console.log("");
}

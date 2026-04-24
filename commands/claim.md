---
description: Claim a shared resource lock (CI, deploy, port, DB, ...).
argument-hint: <resource-name> [reason]
---

Call the `claude-presence` MCP `resource_claim` tool.

Parse `$ARGUMENTS`:
- The first word is the resource name (e.g. `ci`, `deploy:staging`, `port:3000`, `db:staging`).
- The rest of the line, if any, is the reason.

Use the current session's `session_id` (the one you used at `session_register`) and the project's absolute path.

If the result is `ok: true`, confirm briefly: lock acquired, TTL, when to release.

If the result is `ok: false`:
- Report who holds the lock, their branch, and their intent if available.
- Do NOT proceed with the shared operation.
- Ask the user whether to wait, to use broadcast to coordinate, or to abort.

If `$ARGUMENTS` is empty, ask the user which resource to claim.

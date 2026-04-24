---
description: Show other claude-presence sessions and resource locks active on this project.
---

Call `claude-presence` MCP `session_list` and `resource_list` in parallel, scoped to the current project (absolute path).

Exclude the current session from the session list (use `exclude_session_id`).

Present the result concisely:
- **Other sessions**: count + for each one: branch + intent + seen N seconds ago.
- **Active locks**: count + for each one: resource + holder's branch + reason + TTL remaining.

If both are empty, just say "no other sessions, no locks — you're alone on this project".

---
description: Release a shared resource lock previously claimed by this session.
argument-hint: <resource-name>
---

Call the `claude-presence` MCP `resource_release` tool with:

- `session_id`: this session's id (from `session_register`).
- `project`: the project's absolute path.
- `resource`: the resource name from `$ARGUMENTS`.

If `$ARGUMENTS` is empty, first call `resource_list` for this project, show the user the locks this session currently holds, and ask which one to release.

After release, confirm briefly and mention that other waiting sessions (if any) can now proceed.

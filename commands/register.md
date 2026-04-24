---
description: Register this Claude Code session with claude-presence (MCP coordination).
---

Call the `claude-presence` MCP `session_register` tool with:

- `session_id`: a short stable id for this session. Use the Claude Code session id if known, otherwise generate a short random one like `s-<4 random chars>`.
- `project`: the current working directory (absolute path).
- `branch`: the current git branch (run `git rev-parse --abbrev-ref HEAD` if unknown).
- `intent`: a one-line description of what this session is doing. If the user provided arguments to this command ($ARGUMENTS), use that as the intent. Otherwise ask the user what they're working on.
- `pid`: the Claude Code process PID if known (optional).

After registration, if other sessions are active on the same project, summarise them briefly (count, their branches, their intents) so the user is aware.

If `$ARGUMENTS` is non-empty, use it as the intent without asking.

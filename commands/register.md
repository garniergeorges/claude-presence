---
description: Register this Claude Code session with claude-presence (MCP coordination).
---

Call the `claude-presence` MCP `session_register` tool with:

- `session_id`: a short stable id for this session. Use the Claude Code session id if known, otherwise generate a short random one like `s-<4 random chars>`.
- `project`: the current working directory (absolute path).
- `branch`: the current git branch (run `git rev-parse --abbrev-ref HEAD` if unknown).
- `intent`: a one-line description of what this session is doing. If the user provided arguments to this command ($ARGUMENTS), use that as the intent. Otherwise ask the user what they're working on.
- `pid`: the Claude Code process PID if known (optional).
- `client_session_id`: the literal value `${CLAUDE_SESSION_ID}`. This lets the `UserPromptSubmit` hook resolve "me" from the session id Claude Code sends on stdin, so direct messages and warning/urgent broadcasts surface automatically on the next prompt without the user typing `/inbox`.

If the tool response is `ok: false` with `reason: "client_session_id_conflict"`, it means another claude-presence session is still mapped to this Claude Code session id (typical case: previous session was not unregistered cleanly). Tell the user the `held_by` id from the response and suggest either `/release` then retry, or registering without `client_session_id` and accepting that auto-surfacing of notifications won't work for this session.

After registration, if other sessions are active on the same project, summarise them briefly (count, their branches, their intents) so the user is aware.

If `$ARGUMENTS` is non-empty, use it as the intent without asking.

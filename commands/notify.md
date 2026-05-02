---
description: Send a direct notification to one specific session on this project. Wraps broadcast with a target session and warning priority.
argument-hint: <session-id> <message>
---

Call the `claude-presence` MCP `broadcast` tool with `to_session` set and `priority: 'warning'` so the recipient sees it on their next prompt without calling `/inbox`.

Parse `$ARGUMENTS`:
- The first whitespace-delimited token is the recipient `session-id`.
- The rest is the `message`. If either is missing, ask the user.

If you don't know the candidate session ids, suggest the user run `/presence` first.

Required args for the tool:
- `session_id`: this session's id (from `session_register`). If unknown, ask the user to `/register` first.
- `project`: the project's absolute path.
- `from_branch`: the current git branch if available; omit otherwise.
- `to_session`: the parsed recipient id.
- `priority`: `"warning"` (so the message is auto-surfaced on the recipient's next prompt).
- `message`: the parsed message string.

After posting, confirm in one line: `notified <recipient> (warning, id <n>)`.

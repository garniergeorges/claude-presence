---
description: Post a message to the project inbox so other sessions on this project can see it. Supports targeting and priority.
argument-hint: [--to <session>] [--priority info|warning|urgent] <message>
---

Call the `claude-presence` MCP `broadcast` tool.

Parse `$ARGUMENTS`:
- If it begins with `--to <session-id>`, capture `to_session` and remove that prefix from the message.
- If it begins with `--priority <info|warning|urgent>`, capture `priority` and remove that prefix.
- Both flags may appear in any order; the rest is the `message`. If `message` is empty after parsing, ask the user what to post.

Required args for the tool:
- `session_id`: this session's id (from `session_register`). If unknown, ask the user to `/register` first, then retry.
- `project`: the project's absolute path.
- `from_branch`: the current git branch if available (`git rev-parse --abbrev-ref HEAD`); omit if not a git repo.
- `message`: the parsed message string.
- `to_session`: only set if `--to` was passed.
- `priority`: only set if `--priority` was passed (default `info` server-side).
- `tags`: optional, only set if the message clearly starts with a category prefix like `ci:`, `refactor:`, etc.

After posting, confirm in one line: the message id, target (`→ <session>` or `→ all`), and priority. Remind the user that `warning` and `urgent` messages will appear automatically on the recipient's next prompt; `info` requires `/inbox`.

Keep messages short. This is a bulletin board, not chat.

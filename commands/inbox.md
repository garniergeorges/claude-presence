---
description: Read messages addressed to this session — direct messages and project-wide broadcasts.
argument-hint: [all|unread] [--peek] [--min-priority info|warning|urgent]
---

Call the `claude-presence` MCP `read_inbox` tool.

Parse `$ARGUMENTS`:
- If it contains `all`, call with `unread_only: false` to show the full history (last 50 messages).
- Otherwise (or with `unread`), call with `unread_only: true`.
- If it contains `--peek`, pass `peek: true` so the messages stay marked as unread.
- If it contains `--min-priority <info|warning|urgent>`, pass `min_priority`.

Required args:
- `session_id`: this session's id (from `session_register`). If unknown, ask the user to `/register` first.
- `project`: the project's absolute path.

Present each message as:
- `[time ago] [priority] from <session> (branch) → <target>: message`

Where `<target>` is either `me` (direct message addressed to this session, i.e. `to_session = my session_id`) or `all` (project-wide broadcast). Hide the `[priority]` bracket when priority is `info`.

If a message has `tags`, prepend them in brackets after priority.

If there are no messages, say so plainly (`No new messages` for unread, `No messages yet` for all).

The tool response includes `unread_total` (count at the moment of the call, before mark-as-read) and `total` (count of all visible messages on this project). Surface both, e.g. "3 new, 12 total" — especially when the user re-runs `/inbox` rapidly and wonders if they missed something.

Unless `--peek` was passed, returned messages are auto-marked as read by the tool. Don't warn, just show them.

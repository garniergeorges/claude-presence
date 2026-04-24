---
description: Read broadcast messages posted by other Claude Code sessions on this project.
argument-hint: [all|unread]
---

Call the `claude-presence` MCP `read_inbox` tool.

Parse `$ARGUMENTS`:
- If `all`, call with `unread_only: false` to show the full history (last 50 messages).
- If `unread` or empty (default), call with `unread_only: true` to show only messages you haven't read yet.

Required args:
- `session_id`: this session's id (from `session_register`). If unknown, ask the user to `/register` first, then retry.
- `project`: the project's absolute path.

Present each message as:
- `[time ago] from-session (branch): message`

If a message has `tags`, prepend them in brackets. If there are no messages, say so plainly (`No new messages` for unread, `No messages yet` for all).

The tool response includes `unread_total` (count of unread at the moment of the call, before marking-as-read) and `total` (count of all messages from other sessions on this project). Use these to give the user context, e.g. "3 new messages, 12 total on this project" — especially when the user re-runs `/inbox` rapidly and wonders if they missed something.

After displaying, messages returned with unread_only are automatically marked as read by the tool — don't warn the user, just show them.

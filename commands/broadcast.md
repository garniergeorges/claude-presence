---
description: Post a short message to the project-wide inbox so other Claude Code sessions on this project can see it.
argument-hint: <message>
---

Call the `claude-presence` MCP `broadcast` tool.

Use `$ARGUMENTS` as the `message`. If `$ARGUMENTS` is empty, ask the user what message to post.

Required args for the tool:
- `session_id`: this session's id (from `session_register`). If unknown, ask the user to `/register` first, then retry.
- `project`: the project's absolute path.
- `from_branch`: the current git branch if available (`git rev-parse --abbrev-ref HEAD`); omit if not a git repo.
- `message`: the full `$ARGUMENTS` string.
- `tags`: optional, only set if the user's message clearly starts with a category like "warning:", "heads-up:", "ci:" etc.

After posting, confirm briefly (1 line) with the message id and a reminder that other sessions will see it on their next `/inbox` call or `/presence`.

Keep messages short. This is a bulletin board, not chat.

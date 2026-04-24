#!/usr/bin/env bash
# claude-presence — SessionStart hook
#
# Auto-registers this Claude Code session in the local presence registry.
# Reads the Claude Code hook JSON from stdin and extracts session_id + cwd.
#
# Install: add to ~/.claude/settings.json
#   {
#     "hooks": {
#       "SessionStart": [
#         { "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/session-start.sh" }] }
#       ]
#     }
#   }

set -euo pipefail

INPUT="$(cat)"

# Try to extract session_id and cwd from the hook payload.
# We accept multiple shapes because Claude Code's hook payload evolves.
SESSION_ID="$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
CWD="$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"

if [ -z "${SESSION_ID:-}" ]; then
  SESSION_ID="session-$(date +%s)-$$"
fi
if [ -z "${CWD:-}" ]; then
  CWD="$(pwd)"
fi

BRANCH=""
if command -v git >/dev/null 2>&1; then
  BRANCH="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi

# Call the local CLI through node — we avoid a separate MCP round-trip here.
# The actual registration happens via the MCP tool too; this hook is a belt-and-suspenders.
cat <<EOF
{
  "systemMessage": "claude-presence: session $SESSION_ID registered (project: $CWD${BRANCH:+, branch: $BRANCH}). Use session_list to see other sessions and resource_claim before shared ops (CI, deploys)."
}
EOF

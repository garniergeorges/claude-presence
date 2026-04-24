#!/usr/bin/env bash
# claude-presence — UserPromptSubmit hook
#
# Injects a one-line status of other sessions on the same project into the prompt context.
# Runs on every user prompt, so it MUST be fast (< 100ms).
#
# Install: add to ~/.claude/settings.json
#   {
#     "hooks": {
#       "UserPromptSubmit": [
#         { "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/user-prompt-submit.sh" }] }
#       ]
#     }
#   }

set -euo pipefail

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
CWD="$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"

if [ -z "${CWD:-}" ]; then
  CWD="$(pwd)"
fi

# Silently succeed if CLI isn't installed — don't block the prompt.
if ! command -v claude-presence >/dev/null 2>&1; then
  exit 0
fi

STATUS_JSON="$(claude-presence status --project "$CWD" --json 2>/dev/null || echo '[]')"
LOCKS_JSON="$(claude-presence locks --project "$CWD" --json 2>/dev/null || echo '[]')"

OTHER_COUNT="$(printf '%s' "$STATUS_JSON" | grep -c '"id"' || true)"
# Subtract ourselves if session_id is known
if [ -n "${SESSION_ID:-}" ] && printf '%s' "$STATUS_JSON" | grep -q "\"$SESSION_ID\""; then
  OTHER_COUNT=$((OTHER_COUNT - 1))
fi

LOCK_COUNT="$(printf '%s' "$LOCKS_JSON" | grep -c '"resource"' || true)"

if [ "$OTHER_COUNT" -le 0 ] && [ "$LOCK_COUNT" -le 0 ]; then
  exit 0
fi

MSG="claude-presence: "
if [ "$OTHER_COUNT" -gt 0 ]; then
  MSG="${MSG}${OTHER_COUNT} other session(s) active on this project"
fi
if [ "$LOCK_COUNT" -gt 0 ]; then
  [ "$OTHER_COUNT" -gt 0 ] && MSG="${MSG}, "
  MSG="${MSG}${LOCK_COUNT} active resource lock(s)"
fi
MSG="${MSG}. Call session_list and resource_list for details before shared operations."

cat <<EOF
{
  "additionalContext": "$MSG"
}
EOF

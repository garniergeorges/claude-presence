#!/usr/bin/env bash
# claude-presence — UserPromptSubmit hook
#
# Surfaces unread inbox messages and a one-line presence summary on each prompt.
# Direct messages (to_session = me) and warning/urgent broadcasts are injected
# verbatim. Lower-priority broadcasts only contribute to the counter.
#
# Runs on every user prompt, so it MUST be fast (< 100ms).

set -euo pipefail

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
CWD="$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"

if [ -z "${CWD:-}" ]; then
  CWD="$(pwd)"
fi

if ! command -v claude-presence >/dev/null 2>&1; then
  exit 0
fi

# Auto-refresh the session's branch if it has drifted since the last
# register/refresh (typical case: the user ran `git checkout` between
# two prompts). Idempotent and silent — no-op if branch is unchanged
# or session unknown.
if [ -n "${SESSION_ID:-}" ] && command -v git >/dev/null 2>&1; then
  CURRENT_BRANCH="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ -n "${CURRENT_BRANCH:-}" ]; then
    claude-presence refresh-branch \
      --project "$CWD" \
      --session "$SESSION_ID" \
      --branch "$CURRENT_BRANCH" \
      --json >/dev/null 2>&1 || true
  fi
fi

STATUS_JSON="$(claude-presence status --project "$CWD" --json 2>/dev/null || echo '[]')"
LOCKS_JSON="$(claude-presence locks --project "$CWD" --json 2>/dev/null || echo '[]')"

OTHER_COUNT="$(printf '%s' "$STATUS_JSON" | grep -c '"id"' || true)"
if [ -n "${SESSION_ID:-}" ] && printf '%s' "$STATUS_JSON" | grep -q "\"$SESSION_ID\""; then
  OTHER_COUNT=$((OTHER_COUNT - 1))
fi
LOCK_COUNT="$(printf '%s' "$LOCKS_JSON" | grep -c '"resource"' || true)"

# Peek high-priority messages addressed to this session (DMs + warning/urgent broadcasts).
# Peek = no mark-as-read, so /inbox still shows them.
INBOX_TEXT=""
INBOX_COUNT=0
if [ -n "${SESSION_ID:-}" ]; then
  INBOX_JSON="$(claude-presence inbox --project "$CWD" --session "$SESSION_ID" --peek --json 2>/dev/null || echo '{}')"
  INBOX_COUNT="$(printf '%s' "$INBOX_JSON" | sed -n 's/.*"unread_total"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -n 1)"
  INBOX_COUNT="${INBOX_COUNT:-0}"

  # Surface DMs and warning/urgent broadcasts as full text (not just a counter).
  HIGH_JSON="$(claude-presence inbox --project "$CWD" --session "$SESSION_ID" --peek --min-priority warning --json 2>/dev/null || echo '{}')"
  if printf '%s' "$HIGH_JSON" | grep -q '"messages"'; then
    INBOX_TEXT="$(node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        try {
          const r = JSON.parse(s);
          const msgs = (r && r.messages) || [];
          if (!msgs.length) return;
          const lines = msgs.map((m) => {
            const target = m.to_session ? "DM" : "broadcast";
            const tag = m.priority && m.priority !== "info" ? "[" + m.priority + "] " : "";
            return "- " + tag + target + " from " + m.from_session + (m.from_branch ? " (" + m.from_branch + ")" : "") + ": " + m.message.replace(/\s+/g, " ");
          });
          process.stdout.write(lines.join("\n"));
        } catch (e) {}
      });
    ' <<EOF
$HIGH_JSON
EOF
    )"
  fi
fi

if [ "$OTHER_COUNT" -le 0 ] && [ "$LOCK_COUNT" -le 0 ] && [ "${INBOX_COUNT:-0}" -le 0 ]; then
  exit 0
fi

SUMMARY="claude-presence: "
SEP=""
if [ "$OTHER_COUNT" -gt 0 ]; then
  SUMMARY="${SUMMARY}${OTHER_COUNT} other session(s) active"
  SEP=", "
fi
if [ "$LOCK_COUNT" -gt 0 ]; then
  SUMMARY="${SUMMARY}${SEP}${LOCK_COUNT} active lock(s)"
  SEP=", "
fi
if [ "${INBOX_COUNT:-0}" -gt 0 ]; then
  SUMMARY="${SUMMARY}${SEP}${INBOX_COUNT} unread inbox message(s)"
fi
SUMMARY="${SUMMARY}."

if [ -n "$INBOX_TEXT" ]; then
  CONTEXT="${SUMMARY}

Pending notifications (peek, still unread — call read_inbox to mark as read):
${INBOX_TEXT}"
else
  CONTEXT="${SUMMARY} Call session_list, resource_list, or read_inbox for details before shared operations."
fi

# JSON-escape the context payload.
ESCAPED="$(printf '%s' "$CONTEXT" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => process.stdout.write(JSON.stringify(s)));
')"

cat <<EOF
{
  "additionalContext": ${ESCAPED}
}
EOF

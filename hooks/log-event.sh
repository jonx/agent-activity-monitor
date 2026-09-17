#!/usr/bin/env bash
# Agent hook (Claude Code, Codex): append one JSON line per event to ~/.agent-activity/events.jsonl
# Usage (from settings.json): log-event.sh <event-name>   (hook input JSON on stdin)
set -u
LOG_DIR="${AGENT_ACTIVITY_DIR:-$HOME/.agent-activity}"
MAX_BYTES="${AGENT_ACTIVITY_MAX_BYTES:-5000000}"   # rotate events.jsonl above this size; one previous file is kept
mkdir -p "$LOG_DIR"
EVENT="${1:-unknown}"
LOG="$LOG_DIR/events.jsonl"
if [ -f "$LOG" ]; then
  size=$(stat -f %z "$LOG" 2>/dev/null || stat -c %s "$LOG" 2>/dev/null || echo 0)
  [ "$size" -gt "$MAX_BYTES" ] && mv -f "$LOG" "$LOG.1"
fi
KIND="${2:-claude}"   # claude | codex

# Find the agent process (claude or codex) this hook belongs to (walk up the parent chain).
agent_pid=""
p=$PPID
for _ in 1 2 3 4 5 6; do
  [ -z "$p" ] || [ "$p" -le 1 ] && break
  cmd=$(ps -o command= -p "$p" 2>/dev/null)
  case "$cmd" in
    *native-binary/claude*|*/claude\ *|claude\ *|claude|*/codex\ *|*/codex|codex\ *|codex) agent_pid=$p; break ;;
  esac
  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
done

jq -c \
  --arg ev "$EVENT" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg cpid "$agent_pid" \
  --arg kind "$KIND" '
  def clip: (. // "" | tostring | .[0:240]);
  {
    ts: $ts,
    kind: $kind,
    event: (.hook_event_name // $ev),
    session: .session_id,
    agent_pid: ($cpid | if . == "" then null else tonumber end),
    cwd: .cwd,
    tool: .tool_name,
    tool_use_id: .tool_use_id,
    agent_id: .agent_id,
    agent_type: .agent_type,
    background: (.tool_input.run_in_background // false),
    permission_mode: .permission_mode,
    effort: .effort,
    duration_ms: .duration_ms,
    interrupted: (.is_interrupt // null),
    notification: (if $ev == "Notification" then (.notification_type // .type // "notification") else null end),
    exit_code: ([.error // "" | tostring | capture("Exit code (?<c>[0-9]+)") | .c | tonumber] | .[0] // null),
    command: (if .tool_name == "Bash" or .tool_name == "Monitor" then (.tool_input.command // "" | tostring | .[0:600]) else null end),
    summary: (
      if .tool_name == "Bash" then (.tool_input.description // .tool_input.command | clip)
      elif .tool_name == "Agent" then ((.tool_input.description // "agent") + " [" + (.tool_input.subagent_type // "general") + "]" | clip)
      elif .tool_name == "Workflow" then (.tool_input.name // "workflow" | clip)
      elif .tool_name == "Skill" then (.tool_input.skill | clip)
      elif .tool_name == "Monitor" then (.tool_input.description // .tool_input.command | clip)
      elif .tool_name != null then (.tool_input.file_path // .tool_input.pattern // .tool_input.path // .tool_input.url // "" | clip)
      elif .prompt != null then (.prompt | clip)
      elif .message != null then (.message | clip)
      elif .agent_type != null then (.agent_type | clip)
      else "" end),
    error: (if $ev == "PermissionDenied" then "permission denied" elif $ev == "PostToolUseFailure" then (.error // .tool_response // "failed" | tostring | .[-400:]) else null end)
  }' >> "$LOG" 2>/dev/null
# Claude Code lists compaction hooks in its "Compacted" summary; ask it not to show ours.
case "$EVENT" in PreCompact|PostCompact) printf '{"suppressOutput":true}\n' ;; esac
exit 0

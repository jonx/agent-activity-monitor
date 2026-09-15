#!/bin/bash
# Install claude-activity: hooks for Claude Code (and Codex, if present) + the VS Code extension.
# Safe to re-run. Requires jq. Existing hooks in your settings are kept.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/hooks/log-event.sh"
chmod +x "$HOOK"
command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }

EVENTS="PreToolUse PostToolUse PostToolUseFailure SubagentStart SubagentStop SessionStart SessionEnd UserPromptSubmit Stop"

# --- Claude Code: ~/.claude/settings.json ---------------------------------
CLAUDE="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
[ -f "$CLAUDE" ] || echo '{}' > "$CLAUDE"
cp "$CLAUDE" "$CLAUDE.bak"
tmp=$(mktemp)
jq --arg hook "$HOOK" --arg events "$EVENTS" '
  def entry($ev): {hooks: [{type: "command", command: ($hook + " " + $ev), async: true, timeout: 10}]};
  def has($list; $ev): any($list[]?; .hooks[]?.command | tostring | test("log-event\\.sh " + $ev + "$"));
  reduce ($events | split(" "))[] as $ev (.;
    .hooks[$ev] = (if has((.hooks[$ev] // []); $ev) then .hooks[$ev] else ((.hooks[$ev] // []) + [entry($ev)]) end))
' "$CLAUDE" > "$tmp" && mv "$tmp" "$CLAUDE"
echo "Claude Code hooks: $CLAUDE (backup in $CLAUDE.bak)"

# --- Codex: ~/.codex/hooks.json (same hook protocol) ------------------------
if [ -d "$HOME/.codex" ]; then
  CODEX="$HOME/.codex/hooks.json"
  [ -f "$CODEX" ] || echo '{}' > "$CODEX"
  cp "$CODEX" "$CODEX.bak"
  jq --arg hook "$HOOK" --arg events "$EVENTS" '
    def entry($ev): {hooks: [{type: "command", command: ($hook + " " + $ev + " codex"), timeout: 10}]};
    def has($list; $ev): any($list[]?; .hooks[]?.command | tostring | test("log-event\\.sh " + $ev + " codex$"));
    reduce ($events | split(" ") | map(select(. != "PostToolUseFailure")))[] as $ev (.;
      .hooks[$ev] = (if has((.hooks[$ev] // []); $ev) then .hooks[$ev] else ((.hooks[$ev] // []) + [entry($ev)]) end))
  ' "$CODEX" > "$tmp" && mv "$tmp" "$CODEX"
  echo "Codex hooks: $CODEX (Codex will ask you to trust them once)"
fi

# --- VS Code extension (dev install via symlink) ---------------------------
EXT_DIR="$HOME/.vscode/extensions"
mkdir -p "$EXT_DIR"
ln -sfn "$HERE/extension" "$EXT_DIR/jonx.claude-activity-0.1.0"
echo "VS Code extension linked: $EXT_DIR/jonx.claude-activity-0.1.0"
echo "Now run 'Developer: Reload Window' in VS Code (or restart it)."

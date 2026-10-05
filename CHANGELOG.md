# Changelog

## Unreleased

- Codex: `PermissionRequest` and `Interrupt` hooks are registered. A session
  waiting for your approval shows as "needs you"; an interrupted turn goes
  back to idle.
- Codex sessions are titled with their thread name (from
  `~/.codex/session_index.jsonl`); the last prompt moves to the tooltip.
- `install.sh` rewrites its Codex hook entries on every run instead of keeping
  old ones, and registers them as `async`. Codex asks to trust them again after
  such a change.
- README: Codex hooks stay inactive until trusted with `/hooks` in the Codex
  TUI; the VS Code extension never asks.
- Agent colors: a live session's icon is orange for Claude Code and green for
  Codex (`agentActivity.claude`, `agentActivity.codex`); the icon's shape still
  gives the state. The "codex ·" text prefix is gone.
- Less text in the tree: Claude Code session names lose the project prefix
  ("session 21" instead of "aros-apple-silicon-21"), commands without a
  description are shown compacted (no leading `var=path;`, no directories), and
  a session with nothing under it has no arrow and no "nothing running" line.
- The "Recent" group of a session is folded by default.
- Tested versions are listed in the README.

## 0.2.1 - 2026-09-17

- Labels are cut in the middle to a configurable width (`agentActivity.labelChars`).
- Zzz icon for idle sessions, animated icon while the context is compacted.
- Sub-agents keep their task name across resumes; background sub-agents are
  paired with their task, and each background call claims one process.
- Stable node ids: expand/collapse survives refreshes.
- Hook commands say what they are and where they come from; Claude Code no
  longer lists the compaction hooks in its summary.

## 0.2.0 - 2026-09-16

- "Needs you" state for sessions blocked on a permission prompt or a question.
- Sub-agents named by their task, CPU of the busiest process, exit codes,
  turn duration and call count.
- Pastel theme colors, click actions on sessions and calls.

## 0.1.3 - 2026-09-16

- Windows process scan through PowerShell.
- npm and `.exe` installs of Claude Code are recognised as agent processes.

## 0.1.2 - 2026-09-16

- Neutral names: `AGENT_ACTIVITY_*` environment variables, `~/.agent-activity`
  log directory, `agent_pid` field, "Agent Activity" commands.

## 0.1.1 - 2026-09-16

- The event log rotates above 5 MB.
- Settings and commands renamed to `agentActivity.*`.

## 0.1.0 - 2026-09-16

- First release: hooks for Claude Code and Codex, VS Code tree of sessions
  grouped by project, running and recent calls, background commands tracked
  until their process exits, process tree with pause/resume/kill, text dump.

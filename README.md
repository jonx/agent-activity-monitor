# agent-activity-monitor

See what Claude Code (and Codex) are actually running, right now, from VS Code.
Nothing depends on the agent cooperating: the data comes from hooks the harness
fires on its own, and from the process table.

<img src="docs/screenshot.png" width="420" alt="Agent Activity Monitor view in VS Code">


## What you get

- **Sessions grouped by project**, each titled with the last prompt you sent it.
- **Running calls**: shell commands, sub-agents, workflows, with elapsed time.
- **Background commands** stay listed until their process actually exits, and
  the process tree shows them under the agent's own description instead of the
  raw shell wrapper.
- **Process tree** of every `claude` / `codex` process: what really runs under it
  (`cargo test`, `python`, `sleep`, …), compacted without paths, with a hint of
  the deepest program running.
- **Needs you**: a session blocked on a permission prompt or a question turns
  orange and jumps to the top; the status bar says so. Click a session to open it.
- **Sub-agents** named by the task they were given, with their own calls nested.
- **Recent calls** per session, with duration, exit code and error tail on
  failure, `bg` and `agent` tags. Click to open the file or copy the command.
- **Turn info**: elapsed time and number of calls since your last prompt, and a
  `compacting context` state.
- **CPU** of the busiest process under each command, so a stuck job is obvious.
- **Status bar**: `Agents: 2 cmd · 1 agent · 3 proc` or `Agents: idle`.
- Process actions: pause (SIGSTOP), resume (SIGCONT), kill (SIGTERM), copy the
  command. Sessions can be hidden from the view.

## How it works

1. `hooks/log-event.sh` is registered in `~/.claude/settings.json` (and
   `~/.codex/hooks.json`, same protocol) for PreToolUse, PostToolUse,
   PostToolUseFailure, PermissionDenied, Notification, PreCompact, PostCompact,
   SubagentStart/Stop, SessionStart/End, UserPromptSubmit and Stop. Each event appends one JSON line to
   `~/.agent-activity/events.jsonl`. Hooks run async, so the agent is not
   slowed down.
2. The extension tails that file and scans `ps` every two seconds for
   descendants of every agent process. Background calls are matched to their
   process by command text.
3. A text mirror of the view is written to `~/.agent-activity/tree.txt`, so an
   agent (or `tail -f`) can read what you see.

Plain JavaScript, no dependencies, no build step.

## Install

Not on the Marketplace yet: the extension ships as a VSIX on the
[GitHub releases](https://github.com/jonx/agent-activity-monitor/releases) page.

1. Clone the repo and register the hooks (requires `jq`):

   ```sh
   git clone https://github.com/jonx/agent-activity-monitor ~/agent-activity-monitor
   ~/agent-activity-monitor/install.sh --hooks-only
   ```

2. Install the extension: download the `.vsix` from the latest release, then
   `Extensions: Install from VSIX...` in VS Code, or
   `code --install-extension agent-activity-monitor-0.1.0.vsix`.

The view appears in the activity bar after a reload.

`install.sh` merges the hooks into your existing settings (backups are written
next to them). Without `--hooks-only` it also symlinks the extension into
`~/.vscode/extensions`, which is handy while hacking on it. To build the VSIX
yourself:

```sh
cd extension && npx @vscode/vsce package --no-dependencies -o ../agent-activity-monitor.vsix
code --install-extension ../agent-activity-monitor.vsix
```

Do not combine the symlink and the VSIX: remove the symlink first.

Codex (0.154+) asks you to trust the hooks the first time; until then only Codex
processes are visible, not its tool calls.

## Command line

```sh
node ~/agent-activity-monitor/extension/extension.js --dump     # print the tree as text
tail -f ~/.agent-activity/events.jsonl | jq -r '"\(.ts) \(.event) \(.tool // "") \(.summary)"'
```

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `agentActivity.labelChars` | 42 | label width; longer labels are cut in the middle. Tune to your panel width, 0 disables |
| `agentActivity.pollIntervalMs` | 2000 | process scan interval |
| `agentActivity.recentCount` | 8 | finished calls kept per session |
| `agentActivity.staleMinutes` | 15 | hide sessions with no live process after this |
| `agentActivity.logPath` | `~/.agent-activity/events.jsonl` | event log location |

## Platforms

- **macOS**: developed and tested here.
- **Linux**: same code paths (`ps`, bash, jq). npm installs of Claude Code
  (`node …/claude-code/cli.js`) are recognised as agent roots. Not yet tested.
- **Windows**: hooks need Git Bash and `jq` on PATH (Claude Code runs hooks
  through bash when it is installed). The process table comes from PowerShell
  (`Get-CimInstance Win32_Process`); pause/resume are not available. Untested,
  reports welcome. WSL behaves like Linux.

## Colors

Six theme colors, pastel by default, overridable in `workbench.colorCustomizations`:
`agentActivity.working`, `agentActivity.attention`, `agentActivity.error`,
`agentActivity.denied`, `agentActivity.idle`, `agentActivity.background`.

## Limits

- Sub-agents are API calls, not processes: they only show up through hooks.
- Cloud jobs (scheduled routines, cloud reviews) leave no local trace.
- The log stores the first 240 characters of each prompt and 600 of each shell
  command. It rotates above 5 MB (`AGENT_ACTIVITY_MAX_BYTES` in the hook's
  environment changes that; `AGENT_ACTIVITY_DIR` moves the log); one previous file, `events.jsonl.1`, is kept.
  Clear it with *Agent Activity: Clear event log* if it should not stick
  around.

## License

MIT

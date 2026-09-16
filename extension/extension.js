// Agent Activity Monitor — VS Code extension (plain JavaScript, no dependencies).
// Two data sources, both fed without the agent's cooperation:
//   1. ~/.agent-activity/events.jsonl, appended by Claude Code / Codex hooks (tool calls, sub-agents, sessions)
//   2. `ps`, scanned every few seconds for descendants of every `claude` / `codex` process
'use strict';

let vscode;
try { vscode = require('vscode'); } catch { vscode = require('./vscode-stub'); }
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------
function cfg() {
  return vscode.workspace.getConfiguration('agentActivity');
}
function logPath() {
  const p = cfg().get('logPath', '');
  return p && p.trim() ? p.replace(/^~/, os.homedir()) : path.join(os.homedir(), '.agent-activity', 'events.jsonl');
}

// ---------------------------------------------------------------------------
// Event log state (from hooks)
// ---------------------------------------------------------------------------
class EventState {
  constructor() {
    this.sessions = new Map(); // session id -> session
    this.offset = 0;
    this.remainder = '';
  }

  session(id, ev) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, kind: ev.kind || 'claude', cwd: ev.cwd || '', agentPid: ev.agent_pid || ev.claude_pid || null, running: new Map(), agents: new Map(), recent: [], lastTs: 0, ended: false, idle: true,
        attention: null, compacting: false, turnStart: 0, turnCalls: 0, permissionMode: null, effort: null };
      this.sessions.set(id, s);
    }
    if (ev.cwd) s.cwd = ev.cwd;
    const pid = ev.agent_pid || ev.claude_pid; // claude_pid: logs written before 0.1.2
    if (pid) s.agentPid = pid;
    if (ev.permission_mode) s.permissionMode = ev.permission_mode;
    if (ev.effort) s.effort = ev.effort;
    const t = Date.parse(ev.ts || '') || Date.now();
    if (t > s.lastTs) s.lastTs = t;
    return s;
  }

  apply(ev) {
    if (!ev || !ev.session) return;
    const s = this.session(ev.session, ev);
    const t = Date.parse(ev.ts || '') || Date.now();
    const recentMax = cfg().get('recentCount', 8);
    switch (ev.event) {
      case 'SessionStart':
        s.ended = false;
        break;
      case 'UserPromptSubmit':
        s.ended = false;
        s.idle = false;
        s.attention = null;
        s.turnStart = t;
        s.turnCalls = 0;
        // Prompts injected by the harness (background task notifications, system tags) are not the user's words.
        if (ev.summary && !/^\s*</.test(ev.summary)) s.title = ev.summary.replace(/\s+/g, ' ').trim();
        break;
      case 'SessionEnd':
        s.ended = true;
        s.attention = null;
        s.running.clear();
        s.agents.clear();
        break;
      case 'Stop':
        s.idle = true;
        s.compacting = false;
        if (s.attention && s.attention.level !== 'idle') s.attention = null;
        // Foreground calls are all finished when the turn stops; background ones live on as processes.
        for (const [k, r] of s.running) if (!r.bg) s.running.delete(k);
        break;
      case 'PreCompact':
        s.compacting = true;
        break;
      case 'PostCompact':
        s.compacting = false;
        break;
      case 'Notification': {
        // permission_prompt / elicitation_dialog: the agent is blocked on you. idle_prompt: it finished and waits.
        const kind = ev.notification || '';
        if (/permission|elicit|question|input/.test(kind)) s.attention = { level: 'blocked', msg: ev.summary || kind, t };
        else if (/idle/.test(kind)) s.attention = { level: 'idle', msg: ev.summary || 'waiting for your input', t };
        break;
      }
      case 'PreToolUse': {
        s.idle = false;
        s.ended = false;
        s.compacting = false;
        s.turnCalls += 1;
        if (s.attention && s.attention.level === 'idle') s.attention = null;
        const key = ev.tool_use_id || `${ev.tool}-${t}`;
        s.running.set(key, { ...ev, start: t, key });
        if (ev.tool === 'AskUserQuestion') s.attention = { level: 'blocked', msg: 'asks you a question', t };
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied': {
        s.idle = false;
        let key = ev.tool_use_id;
        if (!key || !s.running.has(key)) {
          // No id: close the oldest running call of the same tool.
          for (const [k, r] of s.running) if (r.tool === ev.tool) { key = k; break; }
        }
        const started = key ? s.running.get(key) : null;
        if (s.attention && s.attention.level === 'blocked' && (!started || started.tool !== 'Agent')) s.attention = null;
        const bg = !!(ev.background || (started && started.background));
        if (bg && started && ev.event === 'PostToolUse' && ev.tool === 'Agent' && !started.agentId) {
          // Background Agent call: its sub-agent starts after this; keep the description for pairing.
          s.pendingAgents = (s.pendingAgents || []).filter((c) => t - c.start < 10 * 60 * 1000);
          s.pendingAgents.push(started);
        }
        if (bg && started && ev.event === 'PostToolUse' && ev.tool !== 'Agent') {
          // Launched in the background: keep it "running" until its process disappears (see reconcile()).
          started.bg = true;
          started.launched = t;
          break;
        }
        if (key) s.running.delete(key);
        const dur = ev.duration_ms != null ? ev.duration_ms : (started ? t - started.start : 0);
        s.recent.unshift({ ...ev, start: t - dur, end: t, ok: ev.event === 'PostToolUse', denied: ev.event === 'PermissionDenied',
          summary: ev.summary || (started && started.summary) || '', command: ev.command || (started && started.command) || null,
          background: bg, agent_id: ev.agent_id || (started && started.agent_id) || null });
        if (s.recent.length > recentMax) s.recent.length = recentMax;
        break;
      }
      case 'SubagentStart': {
        // Pair with the oldest running Agent call that has no sub-agent yet: that call's description names the task.
        let call = null;
        for (const r of s.running.values()) if (r.tool === 'Agent' && !r.agentId) { call = r; break; }
        if (!call && s.pendingAgents && s.pendingAgents.length) call = s.pendingAgents.shift();
        const id = ev.agent_id || `agent-${t}`;
        if (call) call.agentId = id;
        s.agents.set(id, { ...ev, start: t, task: call ? call.summary : null });
        break;
      }
      case 'SubagentStop': {
        const id = ev.agent_id && s.agents.has(ev.agent_id) ? ev.agent_id : s.agents.keys().next().value;
        if (id) s.agents.delete(id);
        break;
      }
      default:
        break;
    }
  }

  // Background calls: finished once no process under the session's agent runs that command any more.
  reconcile(procs, procChildrenAll) {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      const root = s.agentPid ? procs.byPid.get(s.agentPid) : null;
      const live = root ? procChildrenAll(root) : [];
      const claimed = new Set();
      // Oldest first, so an older call keeps its process when a newer one has the same command text.
      const bgCalls = [...s.running].filter(([, r]) => r.bg).sort((x, y) => x[1].start - y[1].start);
      for (const [k, r] of bgCalls) {
        if (now - r.launched < 4000) continue; // give the process time to show up in ps
        const p = matchProcess(r, live, claimed);
        if (p) { r.pid = p.pid; claimed.add(p.pid); continue; }
        s.running.delete(k);
        s.recent.unshift({ ...r, end: now, ok: true });
        if (s.recent.length > cfg().get('recentCount', 8)) s.recent.length = cfg().get('recentCount', 8);
      }
    }
  }

  // Read only what was appended since last time. On truncation, start over.
  readNew() {
    const file = logPath();
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (st.size < this.offset) { this.reset(); }
    if (st.size === this.offset) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = st.size;
      const text = this.remainder + buf.toString('utf8');
      const lines = text.split('\n');
      this.remainder = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.apply(JSON.parse(line)); } catch { /* skip malformed line */ }
      }
    } finally { fs.closeSync(fd); }
    return true;
  }

  // First load: only the tail, so a big log does not freeze the extension.
  loadInitial() {
    const file = logPath();
    let st;
    try { st = fs.statSync(file); } catch { return; }
    const MAX = 2 * 1024 * 1024;
    this.offset = st.size > MAX ? st.size - MAX : 0;
    this.remainder = '';
    this.readNew();
    if (st.size > MAX) {
      // The first line may be partial; sessions built from it are still fine.
    }
  }

  reset() {
    this.sessions.clear();
    this.offset = 0;
    this.remainder = '';
  }
}

// ---------------------------------------------------------------------------
// Process scan
// ---------------------------------------------------------------------------
function normCmd(c) { return (c || '').replace(/\\012/g, ' ').replace(/\s+/g, ' ').trim(); }

// Does this logged call correspond to this process? Compare the agent's command with the eval'd part of the wrapper.
function sameCommand(call, proc, exact = false) {
  if (!call.command) return false;
  const a = normCmd(call.command);
  const b = cleanCommand(proc.command);
  if (!a || !b) return false;
  if (a === b) return true;
  if (exact) return false;
  // ps may truncate very long commands: accept a long common prefix.
  const n = 120;
  return (a.length > n && b.startsWith(a.slice(0, n))) || (b.length > n && a.startsWith(b.slice(0, n)));
}
function matchProcess(call, procs, claimed = new Set()) {
  return procs.find((p) => !claimed.has(p.pid) && sameCommand(call, p, true))
    || procs.find((p) => !claimed.has(p.pid) && sameCommand(call, p))
    || null;
}
// Which agent owns this process, if it is an agent root: 'claude', 'codex' or null.
function rootKind(command) {
  // macOS/Linux native binary, npm install (node .../claude-code/cli.js), Windows claude.exe
  if (/native-binary[\/\\]claude(\.exe)?(\s|$)/.test(command) || /(^|[\/\\])claude(\.exe)?(\s|$)/.test(command) || /claude-code[\/\\]cli\.js/.test(command)) return 'claude';
  if (/(^|[\/\\])codex(\.exe)?(\s|$)/.test(command)) return 'codex';
  return null;
}
const IS_WINDOWS = process.platform === 'win32';
function isAgentRoot(command) { return rootKind(command) !== null; }
// Long-lived helper processes that are not tasks themselves; their children are shown in their place.
function isHelper(command) {
  return /codex-code-mode-host/.test(command);
}

function cleanCommand(command) {
  // Claude Code's Bash tool wraps commands in: /bin/zsh -c source <snapshot> ... && eval '<cmd>' < /dev/null && pwd -P >| ...
  const m = command.match(/eval '([\s\S]*?)'(?= < \/dev\/null| && pwd -P|$)/);
  let c = m ? m[1].replace(/'"'"'/g, "'") : command;
  c = c.replace(/\\012/g, ' ').replace(/\s+/g, ' ').trim(); // ps prints newlines as \012
  return c;
}

// Shorten a command for display: drop env exports, keep only basenames of paths, trim.
function compactCommand(command, max = 70) {
  let c = cleanCommand(command);
  c = c.replace(/^(export\s+[^;]*;\s*)+/, '');
  c = c.replace(/^([A-Za-z_][A-Za-z0-9_]*=\S+;?\s*)+/, '');
  c = c.replace(/(?:\/[\w.@+%~-]+){2,}/g, (m) => m.split('/').pop());
  c = c.replace(/(?:[A-Za-z]:)?(?:\\[\w.@+%~ -]+){2,}/g, (m) => m.split('\\').pop()); // Windows paths
  c = c.replace(/2>&1|< \/dev\/null|>\s*\S+/g, '').replace(/\s+/g, ' ').trim();
  c = c.replace(/^(\/bin\/|\/usr\/bin\/)/, '');
  c = c.replace(/-[0-9a-f]{16}\b/g, '');
  return middleEllipsis(c, max);
}

// "cargo test --offline -p afsplus-check …matrix_clone --nocapture": keep both ends, cut the middle.
function middleEllipsis(text, max) {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return text.slice(0, head) + '…' + text.slice(text.length - tail);
}

// ps etime "[[dd-]hh:]mm:ss" -> "14s", "2m05", "1h12"
function shortEtime(etime) {
  const m = String(etime).match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return etime;
  const s = (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]);
  return ago(s * 1000);
}

// Deepest running descendant, for wrappers: what is actually executing right now.
function leafProgram(p) {
  let cur = p;
  while (cur.kids.length) {
    const next = cur.kids.filter(interesting);
    if (!next.length) break;
    cur = next[next.length - 1];
  }
  if (cur === p) return '';
  const first = cleanCommand(cur.command).split(' ')[0] || '';
  return first.split('/').pop().replace(/-[0-9a-f]{16}$/, '');
}
function cpuOf(p) {
  // CPU of the busiest process in the subtree: what tells a stuck job from a working one.
  let best = p.cpu || 0;
  const walk = (q) => { for (const k of q.kids) { if ((k.cpu || 0) > best) best = k.cpu; walk(k); } };
  walk(p);
  return best;
}
function cpuLabel(p) {
  const c = cpuOf(p);
  return c >= 1 ? `${Math.round(c)}% ` : '';
}

// Raw process rows: [{pid, ppid, etime, command}]. `ps` on macOS/Linux, PowerShell on Windows.
function listProcesses() {
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress';
      cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        let rows;
        try { rows = JSON.parse(stdout); } catch { return resolve(null); }
        if (!Array.isArray(rows)) rows = rows ? [rows] : [];
        const now = Date.now();
        resolve(rows.map((r) => {
          const m = String(r.CreationDate || '').match(/(\d{13})/); // "/Date(1699999999999)/"
          const start = m ? +m[1] : null;
          return { pid: +r.ProcessId, ppid: +r.ParentProcessId, etime: start ? ago(now - start) : '', command: r.CommandLine || '' };
        }));
      });
      return;
    }
    cp.execFile('ps', ['-axo', 'pid=,ppid=,etime=,%cpu=,command='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const rows = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)$/);
        if (m) rows.push({ pid: +m[1], ppid: +m[2], etime: m[3], cpu: +m[4], command: m[5] });
      }
      resolve(rows);
    });
  });
}

function scanProcesses() {
  return listProcesses().then((rows) => {
      // available=false: no process table on this platform; sessions are then judged by their events only.
      if (!rows) return { roots: [], byPid: new Map(), available: false };
      const byPid = new Map();
      const children = new Map();
      for (const r of rows) {
        if (!r.pid) continue;
        const p = { ...r, kids: [] };
        byPid.set(p.pid, p);
        if (!children.has(p.ppid)) children.set(p.ppid, []);
        children.get(p.ppid).push(p);
      }
      for (const p of byPid.values()) p.kids = children.get(p.pid) || [];
      const roots = [];
      for (const p of byPid.values()) {
        if (!rootKind(p.command)) continue;
        const parent = byPid.get(p.ppid);
        if (parent && rootKind(parent.command)) continue; // nested agent binary: not a root
        p.kind = rootKind(p.command);
        roots.push(p);
      }
      return { roots, byPid, available: true };
  });
}

// Prune noise: hook scripts, the ps we just ran, and empty wrappers.
function interesting(p) {
  const c = p.command;
  if (/log-event\.sh/.test(c)) return false;
  if (/^ps -axo/.test(c)) return false;
  if (/^\/bin\/zsh -c source .*shell-snapshots.* && eval '(true|pwd -P|ls .*)' /.test(c)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

// File tools: show only the file name; everything else: as logged.
function shortSummary(ev) {
  const sum = ev.summary || '';
  if (['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep'].includes(ev.tool) && sum.startsWith('/')) return sum.split('/').pop();
  return sum || ev.tool || '';
}

// Theme colors contributed in package.json (pastel defaults, overridable in workbench.colorCustomizations).
const COLOR = {
  working: () => new vscode.ThemeColor('agentActivity.working'),
  attention: () => new vscode.ThemeColor('agentActivity.attention'),
  error: () => new vscode.ThemeColor('agentActivity.error'),
  denied: () => new vscode.ThemeColor('agentActivity.denied'),
  idle: () => new vscode.ThemeColor('agentActivity.idle'),
  background: () => new vscode.ThemeColor('agentActivity.background'),
};

function currentWorkspaceRoots() {
  const folders = (vscode.workspace && vscode.workspace.workspaceFolders) || [];
  return folders.map((f) => (f.uri && f.uri.fsPath) || '').filter(Boolean);
}
function isCurrent(cwd, roots) {
  return roots.some((r) => cwd === r || cwd.startsWith(r + path.sep) || r.startsWith(cwd + path.sep));
}

class Node extends vscode.TreeItem {
  constructor(label, state, opts = {}) {
    super(label, state);
    Object.assign(this, opts);
  }
}

class Provider {
  constructor(events) {
    this.events = events;
    this.procs = { roots: [], byPid: new Map(), available: true };
    this.hidden = new Set(); // session ids hidden by the user (until the extension restarts)
    this.meta = new Map(); // session id -> {name, status} from ~/.claude/sessions/*.json
    this.paused = new Set(); // pids we sent SIGSTOP to
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh() { this._em.fire(); }
  getTreeItem(n) { return n; }

  liveSessions() {
    const stale = cfg().get('staleMinutes', 15) * 60 * 1000;
    const now = Date.now();
    const out = [];
    for (const s of this.events.sessions.values()) {
      if (this.hidden.has(s.id)) continue;
      const known = this.procs.available && s.agentPid;
      const alive = known ? this.procs.byPid.has(s.agentPid) : !s.ended; // no process table: trust the events
      if (s.ended && !alive) continue;
      if (known && !alive && now - s.lastTs > stale) continue;
      out.push({ ...s, alive });
    }
    out.sort((a, b) => b.lastTs - a.lastTs);
    return out;
  }

  procChildrenAll(root) {
    const out = [];
    const walk = (p) => { for (const k of p.kids) { out.push(k); walk(k); } };
    walk(root);
    return out;
  }

  // Which logged call (running or recent) launched this process, if any.
  callFor(p) {
    for (const s of this.events.sessions.values()) {
      for (const r of s.running.values()) if (sameCommand(r, p)) return r;
      for (const r of s.recent) if (sameCommand(r, p)) return r;
    }
    return null;
  }

  procChildren(root) {
    const out = [];
    for (const k of root.kids) {
      if (!interesting(k)) continue;
      if (isHelper(k.command)) { out.push(...this.procChildren(k)); continue; }
      if (compactCommand(k.command) === compactCommand(root.command)) { out.push(...this.procChildren(k)); continue; }
      out.push(k);
    }
    return out;
  }

  getChildren(n) {
    if (!n) return this.topLevel();
    if (n.kind === 'session') return this.sessionChildren(n.s);
    if (n.kind === 'group') return n.items;
    if (n.kind === 'process') return this.procChildren(n.p).map((k) => this.procNode(k));
    return [];
  }

  topLevel() {
    const sessions = this.liveSessions();
    const claimed = new Set(sessions.map((s) => s.agentPid));
    // Group sessions by working directory (one node per project).
    const byProject = new Map();
    for (const s of sessions) {
      const key = s.cwd || '?';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(s);
    }
    const nodes = [];
    const here = currentWorkspaceRoots();
    const entries = [...byProject].sort((a, b) => Number(isCurrent(b[0], here)) - Number(isCurrent(a[0], here)));
    for (const [cwd, list] of entries) {
      const running = list.reduce((n, s) => n + s.running.size + s.agents.size, 0);
      const blocked = list.filter((s) => s.attention && s.attention.level === 'blocked').length;
      list.sort((a, b) => Number(!!(b.attention && b.attention.level === 'blocked')) - Number(!!(a.attention && a.attention.level === 'blocked')) || b.lastTs - a.lastTs);
      const items = list.map((s) => this.sessionNode(s));
      const current = isCurrent(cwd, here);
      const color = blocked ? COLOR.attention() : running ? COLOR.working() : current ? COLOR.working() : COLOR.idle();
      nodes.push(new Node(path.basename(cwd) || cwd, vscode.TreeItemCollapsibleState.Expanded, {
        kind: 'group', items,
        description: `${current ? 'this workspace · ' : ''}${list.length} session${list.length > 1 ? 's' : ''}${running ? ' · ' + running + ' running' : ''}${blocked ? ' · ' + blocked + ' needs you' : ''}`,
        tooltip: cwd,
        iconPath: new vscode.ThemeIcon(blocked ? 'bell' : running ? 'sync~spin' : current ? 'folder-active' : 'folder', color),
      }));
    }
    // Agent processes that never emitted a hook event (older sessions, other tools).
    const orphans = this.procs.roots.filter((r) => !claimed.has(r.pid) && this.procChildren(r).length);
    if (orphans.length) {
      nodes.push(new Node('Other agent processes', vscode.TreeItemCollapsibleState.Expanded, {
        kind: 'group',
        items: orphans.map((r) => this.procNode(r)),
        iconPath: new vscode.ThemeIcon('server-process'),
      }));
    }
    if (!nodes.length) {
      nodes.push(new Node('Nothing running', vscode.TreeItemCollapsibleState.None, {
        kind: 'leaf',
        description: fs.existsSync(logPath()) ? '' : 'no event log yet — hooks are not active',
        iconPath: new vscode.ThemeIcon('check'),
      }));
    }
    return nodes;
  }

  sessionNode(s) {
    const running = s.running.size + s.agents.size;
    const meta = this.meta.get(s.id);
    const title = s.title ? middleEllipsis(s.title, 70) : meta && meta.name ? meta.name : `session ${s.id.slice(0, 6)}`;
    const now = Date.now();
    let state, icon, color;
    if (s.attention && s.attention.level === 'blocked') { state = `needs you: ${s.attention.msg}`; icon = 'bell'; color = COLOR.attention(); }
    else if (s.ended) { state = 'ended'; icon = 'circle-outline'; color = COLOR.idle(); }
    else if (!s.alive) { state = 'no process'; icon = 'circle-outline'; color = COLOR.idle(); }
    else if (s.compacting) { state = 'compacting context'; icon = 'fold'; color = COLOR.working(); }
    else if (running) { state = `${running} running`; icon = 'sync~spin'; color = COLOR.working(); }
    else if (s.idle || (meta && meta.status === 'idle')) { state = s.attention ? 'waiting for you' : 'idle'; icon = 'circle-filled'; color = COLOR.idle(); }
    else { state = 'thinking'; icon = 'sync~spin'; color = COLOR.working(); }
    const turn = !s.idle && !s.ended && s.turnStart ? ` · turn ${ago(now - s.turnStart)} · ${s.turnCalls} calls` : '';
    const last = s.recent[0];
    const lastHint = last && !s.ended && !turn ? ` · ${last.tool} ${ago(now - last.end)} ago` : '';
    const tip = [s.cwd, `session ${s.id}`, `${s.kind} pid ${s.agentPid || '?'}`, meta && meta.name ? `name ${meta.name}` : '',
      s.permissionMode ? `permissions ${s.permissionMode}` : '', s.effort ? `effort ${s.effort}` : '',
      s.attention ? `\n${s.attention.msg}` : ''].filter(Boolean).join('\n');
    return new Node(title, running || (s.attention && s.attention.level === 'blocked') ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed, {
      kind: 'session', s,
      description: `${s.kind === 'codex' ? 'codex · ' : ''}${state}${turn}${lastHint}`,
      tooltip: tip,
      iconPath: new vscode.ThemeIcon(icon, color),
      contextValue: 'session',
      command: { command: 'agentActivity.openSession', title: 'Open session', arguments: [s] },
    });
  }

  callNode(r, now) {
    const isBg = !!r.bg;
    const icon = r.tool === 'Bash' ? 'terminal' : r.tool === 'Agent' ? 'hubot' : r.tool === 'Workflow' ? 'type-hierarchy' : r.tool === 'AskUserQuestion' ? 'question' : 'tools';
    return new Node(shortSummary(r), vscode.TreeItemCollapsibleState.None, {
      kind: 'leaf', ev: r,
      description: `${r.tool}${isBg ? ' bg' + (r.pid ? ' pid ' + r.pid : '') : ''} ${ago(now - r.start)}`,
      tooltip: `${r.tool}\n${r.summary}\nstarted ${new Date(r.start).toLocaleTimeString()}${r.command ? '\n\n' + r.command : ''}`,
      iconPath: new vscode.ThemeIcon(icon, isBg ? COLOR.background() : COLOR.working()),
      contextValue: 'tool',
      command: { command: 'agentActivity.openItem', title: 'Open', arguments: [r] },
    });
  }

  sessionChildren(s) {
    const now = Date.now();
    const out = [];
    // Direct calls (not made by a sub-agent, and not the Agent call that a sub-agent node already represents).
    for (const r of s.running.values()) {
      if (r.agent_id || r.agentId) continue;
      out.push(this.callNode(r, now));
    }
    for (const [id, a] of s.agents) {
      const calls = [...s.running.values()].filter((r) => r.agent_id === id);
      const label = a.task ? middleEllipsis(a.task.replace(/\s*\[[^\]]*\]$/, ''), 70) : `agent ${a.agent_type || ''}`.trim();
      out.push(new Node(label, calls.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None, {
        kind: 'group', items: calls.map((r) => this.callNode(r, now)),
        description: `${a.agent_type || 'sub-agent'} ${ago(now - a.start)}${calls.length ? ' · ' + calls.length + ' running' : ''}`,
        tooltip: `sub-agent ${a.agent_id || ''}\n${a.agent_type || ''}\n${a.task || ''}`,
        iconPath: new vscode.ThemeIcon('hubot', COLOR.working()),
      }));
    }
    const root = s.agentPid ? this.procs.byPid.get(s.agentPid) : null;
    const procs = root ? this.procChildren(root) : [];
    if (procs.length) {
      out.push(new Node('Processes', vscode.TreeItemCollapsibleState.Expanded, {
        kind: 'group', items: procs.map((p) => this.procNode(p)),
        description: String(procs.length),
        iconPath: new vscode.ThemeIcon('server-process'),
      }));
    }
    if (s.recent.length) {
      out.push(new Node('Recent', vscode.TreeItemCollapsibleState.Expanded, {
        kind: 'group',
        items: s.recent.map((r) => {
          const status = r.denied ? 'denied' : !r.ok ? (r.exit_code != null ? `exit ${r.exit_code}` : r.interrupted ? 'interrupted' : 'failed') : '';
          const tag = `${r.tool}${r.background ? ' bg' : ''}${r.agent_id ? ' agent' : ''}`;
          return new Node(shortSummary(r), vscode.TreeItemCollapsibleState.None, {
            kind: 'leaf', ev: r,
            description: `${status ? status + ' · ' : ''}${tag} ${ago(r.end - r.start)} · ${new Date(r.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
            tooltip: r.denied ? `PERMISSION DENIED\n${r.summary}` : r.error ? `${r.tool} ${status}\n${r.summary}\n\n${r.error}` : `${r.tool}\n${r.summary}${r.command ? '\n\n' + r.command : ''}`,
            iconPath: new vscode.ThemeIcon(r.ok ? 'check' : r.denied ? 'circle-slash' : 'error', r.ok ? COLOR.idle() : r.denied ? COLOR.denied() : COLOR.error()),
            contextValue: 'tool',
            command: { command: 'agentActivity.openItem', title: 'Open', arguments: [r] },
          });
        }),
        iconPath: new vscode.ThemeIcon('history'),
      }));
    }
    if (!out.length) {
      out.push(new Node('nothing running', vscode.TreeItemCollapsibleState.None, { kind: 'leaf', iconPath: new vscode.ThemeIcon('check', COLOR.idle()) }));
    }
    return out;
  }

  procNode(p) {
    const cmd = cleanCommand(p.command);
    const kids = this.procChildren(p);
    const leaf = leafProgram(p);
    const rk = rootKind(p.command);
    const paused = this.paused.has(p.pid);
    const call = rk ? null : this.callFor(p);
    const label = rk ? `${rk}${/app-server/.test(p.command) ? ' app-server' : ''}` : call && call.summary && call.summary !== call.command ? call.summary : compactCommand(p.command);
    return new Node(label, kids.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None, {
      kind: 'process', p,
      description: `${paused ? 'PAUSED · ' : ''}${rk ? 'pid ' + p.pid + ' · ' : ''}${call && call.bg ? 'bg · ' : ''}${leaf ? '→ ' + leaf + ' ' : ''}${cpuLabel(p)}${shortEtime(p.etime)}`,
      tooltip: `${cmd}\n\npid ${p.pid}  ppid ${p.ppid}  elapsed ${p.etime}`,
      iconPath: new vscode.ThemeIcon(paused ? 'debug-pause' : isAgentRoot(p.command) ? 'circle-filled' : 'terminal', paused ? COLOR.denied() : call && call.bg ? COLOR.background() : cpuOf(p) >= 1 ? COLOR.working() : COLOR.idle()),
      contextValue: rk ? 'agentProcess' : paused ? 'pausedProcess' : IS_WINDOWS ? 'processNoPause' : 'process',
    });
  }
}

// ---------------------------------------------------------------------------
// Text rendering (tree.txt next to the log, and `node extension.js --dump`)
// ---------------------------------------------------------------------------
function renderTree(provider) {
  const lines = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const label = typeof n.label === 'string' ? n.label : (n.label && n.label.label) || '';
      lines.push(`${'  '.repeat(depth)}${label}${n.description ? '  [' + n.description + ']' : ''}`);
      if (n.collapsibleState !== vscode.TreeItemCollapsibleState.None) walk(provider.getChildren(n), depth + 1);
    }
  };
  walk(provider.getChildren(), 0);
  return lines.join('\n') + '\n';
}

// ~/.claude/sessions/<pid>.json: name and busy/idle status as Claude Code itself sees them.
function readSessionMeta() {
  const out = new Map();
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && j.sessionId) out.set(j.sessionId, { name: j.name, status: j.status, pid: j.pid });
    } catch { /* partial write, skip */ }
  }
  return out;
}

async function dumpMain() {
  const events = new EventState();
  events.loadInitial();
  const provider = new Provider(events);
  provider.meta = readSessionMeta();
  provider.procs = await scanProcesses();
  events.reconcile(provider.procs, (r) => provider.procChildrenAll(r));
  process.stdout.write(renderTree(provider));
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
function activate(context) {
  const events = new EventState();
  events.loadInitial();
  const provider = new Provider(events);
  const tree = vscode.window.createTreeView('agentActivity.tree', { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(tree);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'workbench.view.extension.agentActivity';
  context.subscriptions.push(status);

  function updateStatus() {
    let cmds = 0, agents = 0, procs = 0, blocked = 0;
    for (const s of provider.liveSessions()) {
      cmds += s.running.size; agents += s.agents.size;
      if (s.attention && s.attention.level === 'blocked') blocked += 1;
      const root = s.agentPid ? provider.procs.byPid.get(s.agentPid) : null;
      if (root) procs += provider.procChildren(root).length;
    }
    const busy = cmds + agents + procs > 0;
    status.text = blocked ? `$(bell) Agents: ${blocked} need${blocked > 1 ? '' : 's'} you` : busy ? `$(sync~spin) Agents: ${cmds} cmd · ${agents} agent · ${procs} proc` : '$(check) Agents: idle';
    status.backgroundColor = blocked ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.tooltip = 'Agent Activity Monitor — click to open';
    status.show();
  }

  let timer = null;
  let lastText = '';
  async function tick() {
    events.readNew();
    provider.meta = readSessionMeta();
    provider.procs = await scanProcesses();
    events.reconcile(provider.procs, (r) => provider.procChildrenAll(r));
    for (const pid of provider.paused) if (!provider.procs.byPid.has(pid)) provider.paused.delete(pid);
    provider.refresh();
    updateStatus();
    // Mirror of what the view shows, for reading from a terminal or by the agent itself.
    try {
      const text = renderTree(provider);
      if (text !== lastText) { fs.writeFileSync(path.join(path.dirname(logPath()), 'tree.txt'), text); lastText = text; }
    } catch { /* ignore */ }
  }
  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, Math.max(500, cfg().get('pollIntervalMs', 2000)));
  }
  schedule();
  tick();

  // React quickly to new hook events instead of waiting for the next poll.
  let watcher = null;
  function watchLog() {
    if (watcher) { watcher.close(); watcher = null; }
    const dir = path.dirname(logPath());
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    try {
      watcher = fs.watch(dir, (_e, name) => { if (!name || name === path.basename(logPath())) tick(); });
    } catch { /* fall back to polling only */ }
  }
  watchLog();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentActivity')) { schedule(); watchLog(); events.reset(); events.loadInitial(); tick(); }
    }),
    vscode.commands.registerCommand('agentActivity.refresh', tick),
    vscode.commands.registerCommand('agentActivity.openLog', () => {
      vscode.workspace.openTextDocument(logPath()).then((d) => vscode.window.showTextDocument(d), () => vscode.window.showWarningMessage('No event log yet: ' + logPath()));
    }),
    vscode.commands.registerCommand('agentActivity.clearLog', async () => {
      const ok = await vscode.window.showWarningMessage('Clear the event log?', { modal: true }, 'Clear');
      if (ok !== 'Clear') return;
      try { fs.writeFileSync(logPath(), ''); } catch { /* ignore */ }
      events.reset();
      tick();
    }),
    vscode.commands.registerCommand('agentActivity.kill', async (node) => {
      if (!node || !node.p) return;
      const ok = await vscode.window.showWarningMessage(`Kill process ${node.p.pid}?\n${cleanCommand(node.p.command).slice(0, 200)}`, { modal: true }, 'Kill');
      if (ok !== 'Kill') return;
      try { process.kill(node.p.pid, 'SIGTERM'); } catch (e) { vscode.window.showErrorMessage(`kill failed: ${e.message}`); }
      setTimeout(tick, 500);
    }),
    vscode.commands.registerCommand('agentActivity.openSession', async (s) => {
      if (!s) return;
      // Claude Code: its editor.open command takes a session id and focuses an already-open panel for it.
      const attempts = s.kind === 'codex'
        ? [['chatgpt.openSidebar']]
        : [['claude-vscode.editor.open', s.id], ['claude-vscode.editor.openLast'], ['claude-vscode.focus']];
      for (const [cmd, ...args] of attempts) {
        try { await vscode.commands.executeCommand(cmd, ...args); return; } catch { /* try the next one */ }
      }
      vscode.window.showInformationMessage(`Session ${s.id.slice(0, 8)} in ${s.cwd}`);
    }),
    vscode.commands.registerCommand('agentActivity.openItem', async (r) => {
      if (!r) return;
      const sum = r.summary || '';
      if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(r.tool) && /^([A-Za-z]:)?[\/\\]/.test(sum)) {
        try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sum)); } catch (e) { vscode.window.showWarningMessage(`Cannot open ${sum}: ${e.message}`); }
        return;
      }
      const text = r.command || sum;
      if (text) { await vscode.env.clipboard.writeText(text); vscode.window.setStatusBarMessage('$(clippy) command copied', 2000); }
    }),
    vscode.commands.registerCommand('agentActivity.pause', (node) => {
      if (!node || !node.p) return;
      try { process.kill(node.p.pid, 'SIGSTOP'); provider.paused.add(node.p.pid); } catch (e) { vscode.window.showErrorMessage(`pause failed: ${e.message}`); }
      tick();
    }),
    vscode.commands.registerCommand('agentActivity.resume', (node) => {
      if (!node || !node.p) return;
      try { process.kill(node.p.pid, 'SIGCONT'); } catch (e) { vscode.window.showErrorMessage(`resume failed: ${e.message}`); }
      provider.paused.delete(node.p.pid);
      tick();
    }),
    vscode.commands.registerCommand('agentActivity.hideSession', (node) => {
      if (!node || !node.s) return;
      provider.hidden.add(node.s.id);
      provider.refresh();
    }),
    vscode.commands.registerCommand('agentActivity.copy', (node) => {
      const text = node && node.p ? cleanCommand(node.p.command) : node && node.ev ? node.ev.summary : '';
      if (text) vscode.env.clipboard.writeText(text);
    }),
    { dispose: () => { if (timer) clearInterval(timer); if (watcher) watcher.close(); } },
  );
}

function deactivate() {}

module.exports = { activate, deactivate, renderTree, compactCommand };

if (require.main === module && process.argv.includes('--dump')) dumpMain();

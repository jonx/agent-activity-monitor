// Claude Activity — VS Code extension (plain JavaScript, no dependencies).
// Two data sources, both fed without Claude's cooperation:
//   1. ~/.claude/activity/events.jsonl, appended by Claude Code hooks (tool calls, sub-agents, sessions)
//   2. `ps`, scanned every few seconds for descendants of every `claude` process
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
  return vscode.workspace.getConfiguration('claudeActivity');
}
function logPath() {
  const p = cfg().get('logPath', '');
  return p && p.trim() ? p.replace(/^~/, os.homedir()) : path.join(os.homedir(), '.claude', 'activity', 'events.jsonl');
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
      s = { id, kind: ev.kind || 'claude', cwd: ev.cwd || '', claudePid: ev.claude_pid || null, running: new Map(), agents: new Map(), recent: [], lastTs: 0, ended: false, idle: true };
      this.sessions.set(id, s);
    }
    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.claude_pid) s.claudePid = ev.claude_pid;
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
      case 'SessionEnd':
        s.ended = true;
        s.running.clear();
        s.agents.clear();
        break;
      case 'Stop':
        s.idle = true;
        // Background Bash calls already got their PostToolUse when they were launched; nothing left "running" is real.
        s.running.clear();
        break;
      case 'PreToolUse': {
        s.idle = false;
        s.ended = false;
        const key = ev.tool_use_id || `${ev.tool}-${t}`;
        s.running.set(key, { ...ev, start: t, key });
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        s.idle = false;
        let key = ev.tool_use_id;
        if (!key || !s.running.has(key)) {
          // No id: close the oldest running call of the same tool.
          for (const [k, r] of s.running) if (r.tool === ev.tool) { key = k; break; }
        }
        const started = key ? s.running.get(key) : null;
        if (key) s.running.delete(key);
        s.recent.unshift({ ...ev, start: started ? started.start : t, end: t, ok: ev.event === 'PostToolUse', summary: ev.summary || (started && started.summary) || '' , background: ev.background || (started && started.background) });
        if (s.recent.length > recentMax) s.recent.length = recentMax;
        break;
      }
      case 'SubagentStart':
        s.agents.set(ev.agent_id || `agent-${t}`, { ...ev, start: t });
        break;
      case 'SubagentStop':
        if (ev.agent_id && s.agents.has(ev.agent_id)) s.agents.delete(ev.agent_id);
        else { const k = s.agents.keys().next().value; if (k) s.agents.delete(k); }
        break;
      default:
        break;
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
// Which agent owns this process, if it is an agent root: 'claude', 'codex' or null.
function rootKind(command) {
  if (/native-binary\/claude(\s|$)/.test(command) || /(^|\/)claude(\s|$)/.test(command)) return 'claude';
  if (/(^|\/)codex(\s|$)/.test(command)) return 'codex';
  return null;
}
function isClaudeRoot(command) { return rootKind(command) !== null; }
// Long-lived helper processes that are not tasks themselves; their children are shown in their place.
function isHelper(command) {
  return /codex-code-mode-host/.test(command);
}

function cleanCommand(command) {
  // Claude's Bash tool wraps commands in: /bin/zsh -c source <snapshot> ... && eval '<cmd>' < /dev/null && pwd -P >| ...
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
  c = c.replace(/2>&1|< \/dev\/null|>\s*\S+/g, '').replace(/\s+/g, ' ').trim();
  c = c.replace(/^(\/bin\/|\/usr\/bin\/)/, '');
  c = c.replace(/-[0-9a-f]{16}\b/g, '');
  return c.length > max ? c.slice(0, max - 1) + '…' : c;
}

// ps etime "[[dd-]hh:]mm:ss" -> "14s", "2m05", "1h12"
function shortEtime(etime) {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
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

function scanProcesses() {
  return new Promise((resolve) => {
    cp.execFile('ps', ['-axo', 'pid=,ppid=,etime=,command='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ roots: [], byPid: new Map() });
      const byPid = new Map();
      const children = new Map();
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const p = { pid: +m[1], ppid: +m[2], etime: m[3], command: m[4], kids: [] };
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
      resolve({ roots, byPid });
    });
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

class Node extends vscode.TreeItem {
  constructor(label, state, opts = {}) {
    super(label, state);
    Object.assign(this, opts);
  }
}

class Provider {
  constructor(events) {
    this.events = events;
    this.procs = { roots: [], byPid: new Map() };
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
      const alive = s.claudePid && this.procs.byPid.has(s.claudePid);
      if (s.ended && !alive) continue;
      if (!alive && now - s.lastTs > stale) continue;
      out.push({ ...s, alive });
    }
    out.sort((a, b) => b.lastTs - a.lastTs);
    return out;
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
    const claimed = new Set(sessions.map((s) => s.claudePid));
    const nodes = sessions.map((s) => {
      const running = s.running.size + s.agents.size;
      const name = path.basename(s.cwd || '') || s.id.slice(0, 8);
      const state = s.ended ? 'terminée' : !s.alive ? 'sans processus' : running ? `${running} en cours` : s.idle ? 'en attente' : 'active';
      const item = new Node(name, vscode.TreeItemCollapsibleState.Expanded, {
        kind: 'session', s,
        description: `${s.kind === 'codex' ? 'codex · ' : ''}${state}`,
        tooltip: `${s.cwd}\nsession ${s.id}\nclaude pid ${s.claudePid || '?'}`,
        iconPath: new vscode.ThemeIcon(running ? 'sync~spin' : s.alive ? 'circle-filled' : 'circle-outline'),
        contextValue: 'session',
      });
      return item;
    });
    // Claude processes that never emitted a hook event (older sessions, other tools).
    const orphans = this.procs.roots.filter((r) => !claimed.has(r.pid) && this.procChildren(r).length);
    if (orphans.length) {
      nodes.push(new Node('Autres processus', vscode.TreeItemCollapsibleState.Expanded, {
        kind: 'group',
        items: orphans.map((r) => this.procNode(r)),
        iconPath: new vscode.ThemeIcon('server-process'),
      }));
    }
    if (!nodes.length) {
      nodes.push(new Node('Rien en cours', vscode.TreeItemCollapsibleState.None, {
        kind: 'leaf',
        description: fs.existsSync(logPath()) ? '' : 'aucun journal — les hooks ne sont pas encore actifs',
        iconPath: new vscode.ThemeIcon('check'),
      }));
    }
    return nodes;
  }

  sessionChildren(s) {
    const now = Date.now();
    const out = [];
    for (const r of s.running.values()) {
      out.push(new Node(shortSummary(r), vscode.TreeItemCollapsibleState.None, {
        kind: 'leaf', ev: r,
        description: `${r.tool}${r.background ? ' bg' : ''}${r.agent_id ? ' agent' : ''} ${ago(now - r.start)}`,
        tooltip: `${r.tool}\n${r.summary}\nstarted ${new Date(r.start).toLocaleTimeString()}${r.agent_id ? `\nsub-agent ${r.agent_type || ''} ${r.agent_id}` : ''}`,
        iconPath: new vscode.ThemeIcon(r.tool === 'Bash' ? 'terminal' : r.tool === 'Agent' ? 'hubot' : r.tool === 'Workflow' ? 'type-hierarchy' : 'tools'),
        contextValue: 'tool',
      }));
    }
    for (const a of s.agents.values()) {
      out.push(new Node(`agent ${a.agent_type || a.summary || ''}`.trim(), vscode.TreeItemCollapsibleState.None, {
        kind: 'leaf',
        description: `sous-agent ${ago(now - a.start)}`,
        tooltip: `agent ${a.agent_id || ''}\n${a.agent_type || ''}`,
        iconPath: new vscode.ThemeIcon('hubot'),
      }));
    }
    const root = s.claudePid ? this.procs.byPid.get(s.claudePid) : null;
    const procs = root ? this.procChildren(root) : [];
    if (procs.length) {
      out.push(new Node('Processus', vscode.TreeItemCollapsibleState.Expanded, {
        kind: 'group', items: procs.map((p) => this.procNode(p)),
        description: String(procs.length),
        iconPath: new vscode.ThemeIcon('server-process'),
      }));
    }
    if (s.recent.length) {
      out.push(new Node('Récents', vscode.TreeItemCollapsibleState.Collapsed, {
        kind: 'group',
        items: s.recent.map((r) => new Node(shortSummary(r), vscode.TreeItemCollapsibleState.None, {
          kind: 'leaf', ev: r,
          description: `${r.tool}${r.background ? ' bg' : ''} ${ago(r.end - r.start)} · ${new Date(r.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          tooltip: r.error ? `FAILED\n${r.error}` : `${r.tool}\n${r.summary}`,
          iconPath: new vscode.ThemeIcon(r.ok ? 'check' : 'error', r.ok ? undefined : new vscode.ThemeColor('errorForeground')),
          contextValue: 'tool',
        })),
        iconPath: new vscode.ThemeIcon('history'),
      }));
    }
    if (!out.length) {
      out.push(new Node('rien en cours', vscode.TreeItemCollapsibleState.None, { kind: 'leaf', iconPath: new vscode.ThemeIcon('check') }));
    }
    return out;
  }

  procNode(p) {
    const cmd = cleanCommand(p.command);
    const kids = this.procChildren(p);
    const leaf = leafProgram(p);
    const rk = rootKind(p.command);
    const label = rk ? `${rk}${/app-server/.test(p.command) ? ' app-server' : ''}` : compactCommand(p.command);
    return new Node(label, kids.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None, {
      kind: 'process', p,
      description: `${rk ? 'pid ' + p.pid + ' · ' : ''}${leaf ? '→ ' + leaf + ' ' : ''}${shortEtime(p.etime)}`,
      tooltip: `${cmd}\n\npid ${p.pid}  ppid ${p.ppid}  elapsed ${p.etime}`,
      iconPath: new vscode.ThemeIcon(isClaudeRoot(p.command) ? 'circle-filled' : 'terminal'),
      contextValue: 'process',
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

async function dumpMain() {
  const events = new EventState();
  events.loadInitial();
  const provider = new Provider(events);
  provider.procs = await scanProcesses();
  process.stdout.write(renderTree(provider));
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
function activate(context) {
  const events = new EventState();
  events.loadInitial();
  const provider = new Provider(events);
  const tree = vscode.window.createTreeView('claudeActivity.tree', { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(tree);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'workbench.view.extension.claudeActivity';
  context.subscriptions.push(status);

  function updateStatus() {
    let cmds = 0, agents = 0, procs = 0;
    for (const s of provider.liveSessions()) {
      cmds += s.running.size; agents += s.agents.size;
      const root = s.claudePid ? provider.procs.byPid.get(s.claudePid) : null;
      if (root) procs += provider.procChildren(root).length;
    }
    const busy = cmds + agents + procs > 0;
    status.text = busy ? `$(sync~spin) Claude: ${cmds} cmd · ${agents} agent · ${procs} proc` : '$(check) Claude: idle';
    status.tooltip = 'Claude Activity — click to open';
    status.show();
  }

  let timer = null;
  let lastText = '';
  async function tick() {
    events.readNew();
    provider.procs = await scanProcesses();
    provider.refresh();
    updateStatus();
    // Mirror of what the view shows, for reading from a terminal or by Claude itself.
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
      if (e.affectsConfiguration('claudeActivity')) { schedule(); watchLog(); events.reset(); events.loadInitial(); tick(); }
    }),
    vscode.commands.registerCommand('claudeActivity.refresh', tick),
    vscode.commands.registerCommand('claudeActivity.openLog', () => {
      vscode.workspace.openTextDocument(logPath()).then((d) => vscode.window.showTextDocument(d), () => vscode.window.showWarningMessage('Aucun journal pour le moment : ' + logPath()));
    }),
    vscode.commands.registerCommand('claudeActivity.clearLog', async () => {
      const ok = await vscode.window.showWarningMessage('Vider le journal des événements ?', { modal: true }, 'Vider');
      if (ok !== 'Vider') return;
      try { fs.writeFileSync(logPath(), ''); } catch { /* ignore */ }
      events.reset();
      tick();
    }),
    vscode.commands.registerCommand('claudeActivity.kill', async (node) => {
      if (!node || !node.p) return;
      const ok = await vscode.window.showWarningMessage(`Tuer le processus ${node.p.pid} ?\n${cleanCommand(node.p.command).slice(0, 200)}`, { modal: true }, 'Tuer');
      if (ok !== 'Tuer') return;
      try { process.kill(node.p.pid, 'SIGTERM'); } catch (e) { vscode.window.showErrorMessage(`kill failed: ${e.message}`); }
      setTimeout(tick, 500);
    }),
    vscode.commands.registerCommand('claudeActivity.copy', (node) => {
      const text = node && node.p ? cleanCommand(node.p.command) : node && node.ev ? node.ev.summary : '';
      if (text) vscode.env.clipboard.writeText(text);
    }),
    { dispose: () => { if (timer) clearInterval(timer); if (watcher) watcher.close(); } },
  );
}

function deactivate() {}

module.exports = { activate, deactivate, renderTree, compactCommand };

if (require.main === module && process.argv.includes('--dump')) dumpMain();

// Minimal stand-in for the `vscode` module so extension.js can run from the command line (--dump).
'use strict';
module.exports = {
  TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
};

# claude-activity

Voir ce que Claude Code fait tourner, sans que Claude ait rien à déclarer.

Deux sources, toutes deux alimentées automatiquement :

1. **Hooks Claude Code** (`hooks/log-event.sh`). Branchés dans `~/.claude/settings.json` sur
   PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, SessionStart,
   SessionEnd et Stop. Chaque événement ajoute une ligne JSON à `~/.claude/activity/events.jsonl`.
   Les hooks sont `async`, donc ils ne ralentissent pas Claude.
2. **Processus** (`ps`). L'extension repère chaque processus `claude` et liste ses descendants :
   ce sont les commandes réellement en train de tourner, en arrière-plan ou pas.

## Extension VS Code (`extension/`)

JavaScript pur, aucune dépendance, pas de build.

- Vue « Claude Activity » dans la barre d'activité : une entrée par session Claude, avec les
  appels en cours, les sous-agents, l'arbre des processus et les derniers appels terminés.
- Barre d'état : `Claude: 2 cmd · 1 agent · 3 proc` ou `Claude: idle`. Clic pour ouvrir la vue.
- Clic droit sur un processus : tuer, copier la commande.
- Rafraîchi toutes les 2 s (`claudeActivity.pollIntervalMs`) et dès qu'une ligne arrive dans le journal.

### Installation (mode développement)

```sh
ln -sfn /Users/aros/claude-activity/extension ~/.vscode/extensions/jonx.claude-activity-0.1.0
```

Puis dans VS Code : `Developer: Reload Window`.

Pour un paquet installable : `npx @vscode/vsce package` dans `extension/`, puis
`Extensions: Install from VSIX...`.

### Ce qu'on ne voit pas

- Les sous-agents ne sont pas des processus : ils n'apparaissent que via les hooks.
- Les jobs cloud (routines, ultrareview) ne laissent aucune trace locale.
- Une commande lancée en arrière-plan reçoit son PostToolUse immédiatement ; c'est l'arbre des
  processus qui dit si elle tourne encore.

## Journal

Suivre en direct depuis un terminal :

```sh
tail -f ~/.claude/activity/events.jsonl | jq -r '"\(.ts) \(.event) \(.tool // .agent_type // "") \(.summary)"'
```

Vider : commande `Claude Activity: Clear event log`, ou `: > ~/.claude/activity/events.jsonl`.

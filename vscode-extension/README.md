# Grove

Grove is the control plane for parallel AI development -- orchestrate multiple Claude Code agents across git worktrees from one dashboard.

<!-- ![Grove in action](media/grove-demo.gif) -->

## What it does

- **One-click agent teams** -- pick a template (Full-Stack, Code Review, Debug Squad, Migration, Rapid Prototype), enter your task, and Grove creates isolated worktrees, generates per-agent CLAUDE.md files with enforced ownership boundaries, and launches all sessions in parallel. Cancellable mid-launch with full cleanup.
- **Real-time file overlap detection** -- file watchers monitor every worktree and alert you the moment two agents touch the same file, ranked by severity (conflict / warning / info), before it becomes a merge nightmare.
- **Merge intelligence** -- pre-merge safety checks (saves files, stops active sessions), auto-commits tracked changes, captures a recovery hash, and walks you through sequential merges with conflict resolution, test gates, and clear abort messages showing exactly how to undo.
- **Remote sync + behind-remote warnings** -- see at a glance which worktrees are behind the remote (↓3), sync with one click, and get warned before launching Claude in an outdated worktree.
- **Session dashboard** -- a live WebView panel with agent cards, file activity feed, and overlap alerts. Teams persist across VS Code restarts.

## Install

```bash
code --install-extension grove
```

## Quick start

1. Open a git repo in VS Code or Cursor.
2. Click the Grove icon in the Activity Bar.
3. Hit **+** to create a worktree, or the team icon to launch a full agent team.
4. Open the dashboard (`Grove: Open Dashboard`) to monitor everything in real-time.
5. When agents finish, generate a merge report and execute the guided merge sequence.

See [DOCUMENTATION.md](DOCUMENTATION.md) for the full reference.

## License

MIT

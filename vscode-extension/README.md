# Grove — Parallel AI Dev

> Control plane for parallel AI development — orchestrate multiple Claude Code agents across git worktrees from one IDE sidebar.

Built for developers who use [Claude Code](https://code.claude.com) and want to run multiple agents in parallel without the manual worktree juggling, file conflicts, and merge nightmares.

<!-- ![Grove in action](media/grove-demo.gif) -->

## What It Does

- **One-click agent teams** — pick a template (Full-Stack, Code Review, Debug Squad, Migration, Rapid Prototype), enter your task, and Grove creates isolated worktrees, generates per-agent CLAUDE.md files with enforced ownership boundaries, and launches all sessions in parallel
- **Real-time overlap detection** — file watchers monitor every worktree and alert you the moment two agents touch the same file, ranked by severity (conflict / warning / info)
- **Merge intelligence** — auto-commits tracked changes, captures a recovery hash, and walks you through sequential merges with conflict resolution, test gates, and abort safety
- **Live dashboard** — WebView panel with agent cards, file activity feed, and overlap alerts. Teams persist across restarts
- **Worktree management** — create, monitor, sync, diff, and clean up worktrees without leaving your editor

## Requirements

- VS Code 1.85+ or Cursor
- Git installed
- [Claude Code CLI](https://code.claude.com) (`claude` command in your PATH)

## Install

Search **"Grove"** in the Extensions panel, or:
```bash
code --install-extension ShebinMohanK.grove-pilot
```

## Quick Start

1. Open a git repo in VS Code or Cursor
2. Click the Grove icon in the Activity Bar
3. Hit **+** to create a worktree, or the team icon to launch an agent team
4. Open the dashboard (`Grove: Open Dashboard`) to monitor in real-time
5. When agents finish, generate a merge report and execute the guided merge sequence

## Documentation

Full reference: [DOCUMENTATION.md](DOCUMENTATION.md)

## Acknowledgements

Grove automates the [manual parallel sessions with git worktrees](https://code.claude.com/docs/en/common-workflows) workflow documented by Anthropic, wrapping it with a visual interface, overlap detection, and merge intelligence. Built with Claude Code.

## Disclaimer

Grove is an independent open-source project and is not affiliated with, endorsed by, or officially connected to Anthropic. Claude and Claude Code are trademarks of Anthropic.

## License

MIT
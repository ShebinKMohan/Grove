# Grove — Worktree Control for Claude Code

> Orchestrate multiple Claude Code agents across git worktrees from one IDE sidebar.

Built for developers who use [Claude Code](https://code.claude.com) and want to run multiple agents in parallel without the manual worktree juggling, file conflicts, and merge nightmares.

<!-- ![Grove in action](media/grove-demo.gif) -->

## What It Does

- **One-click agent teams** — pick a template (Full-Stack, Code Review, Debug Squad, Migration, Rapid Prototype), enter your task, and Grove creates isolated worktrees, generates per-agent CLAUDE.md files with enforced ownership boundaries, and launches all sessions in parallel
- **Base branch selection** — choose which branch to create worktrees from, with all local branches listed (default base branch first)
- **Inline file browsing** — expand any worktree in the sidebar to see changed files with git status icons (added/modified/deleted/renamed). Click a modified file to open an inline diff view against the base branch
- **Smart sync & push indicators** — sync button appears when behind remote, push button appears when ahead. You know at a glance which branches need pulling or pushing
- **Pre-merge conflict prediction** — before merging, Grove predicts conflicts against the base branch using `git merge-tree` and warns you with the exact files that will conflict
- **Real-time overlap detection** — file watchers monitor every worktree and alert you the moment two agents touch the same file, ranked by severity (conflict / warning / info)
- **Merge intelligence** — auto-commits tracked changes, captures a recovery hash, and walks you through sequential merges with conflict resolution, test gates, and abort safety
- **Clean `.gitignore` management** — worktree paths are auto-committed to `.gitignore` on creation and cleaned up on deletion, keeping your base branch always clean
- **Live dashboard** — WebView panel with two-column session cards, directory-grouped file activity with clickable diffs, and overlap alerts. Teams persist across restarts
- **Worktree management** — create, monitor, sync, diff, and clean up worktrees without leaving your editor
- **User-friendly errors** — every error includes what went wrong and how to fix it. No raw git output or cryptic stack traces

## Requirements

- VS Code 1.85+ or Cursor
- Git installed and in your PATH
- [Claude Code CLI](https://code.claude.com) (`claude` command in your PATH)

## Install

Search **"Grove"** in the Extensions panel, or:
```bash
code --install-extension ShebinMohanK.grove-pilot
```

## Quick Start

1. Open a git repo in VS Code or Cursor
2. Click the Grove icon in the Activity Bar
3. Hit **+** to create a worktree — pick a base branch, then name your new branch
4. Click the rocket icon to launch Claude Code in the worktree
5. Expand the worktree to see changed files and inline diffs
6. Launch an agent team with the team icon for parallel development
7. Open the dashboard (`Grove: Open Dashboard`) to monitor in real-time
8. When agents finish, generate a merge report and execute the guided merge sequence

## Commands

| Command | Description |
|---|---|
| `Grove: Create Worktree` | Create a new worktree from a selected base branch |
| `Grove: Launch Agent Team` | One-click parallel agent launch from a template |
| `Grove: Open Dashboard` | Open the real-time monitoring dashboard |
| `Grove: Generate Merge Report` | Analyze all worktrees for merge readiness |
| `Grove: Execute Merge Sequence` | Guided sequential merge with test gates |
| `Grove: Check File Overlaps` | Scan for files modified in multiple worktrees |
| `Grove: Cleanup Stale Worktrees` | Batch remove worktrees with confirmation |
| `Grove: Stop All Sessions` | Stop all running Claude Code sessions |
| `Grove: Quick Menu` | Access all commands from the status bar |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `grove.defaultBaseBranch` | `main` | Default base branch for new worktrees |
| `grove.worktreeLocation` | `.claude/worktrees` | Directory for worktrees (relative to repo root) |
| `grove.autoInstallDependencies` | `true` | Auto-install deps after creating a worktree |
| `grove.packageManager` | `auto` | Package manager (auto/npm/yarn/pnpm/pip/pipenv/poetry) |
| `grove.maxConcurrentSessions` | `5` | Maximum concurrent Claude Code sessions |
| `grove.enableAgentTeams` | `true` | Enable Agent Teams features |
| `grove.templateDirectory` | `.grove/templates` | Directory for team templates |
| `grove.fileWatcherDebounce` | `500` | Debounce interval (ms) for file change events |
| `grove.notifyOnSessionComplete` | `true` | Notify when a session completes |
| `grove.autoGitignore` | `true` | Auto-add worktree paths to .gitignore |
| `grove.showStatusBarItem` | `true` | Show worktree info in the status bar |
| `grove.protectedBranches` | `["main","master","develop","production"]` | Branches that cannot be deleted |

## Documentation

Full reference: [DOCUMENTATION.md](DOCUMENTATION.md)

## Acknowledgements

Grove automates the [manual parallel sessions with git worktrees](https://code.claude.com/docs/en/common-workflows) workflow documented by Anthropic, wrapping it with a visual interface, overlap detection, and merge intelligence. Built with Claude Code.

## Feedback & Contributions

Got a bug, feature request, or suggestion? [Open an issue](https://github.com/ShebinKMohan/Grove/issues) on GitHub. Pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and guidelines.

## Disclaimer

Grove is an independent open-source project and is not affiliated with, endorsed by, or officially connected to Anthropic. Claude and Claude Code are trademarks of Anthropic.

## License

MIT

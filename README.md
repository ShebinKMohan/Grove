# Grove — Worktree Control for Claude Code

> Orchestrate multiple Claude Code agents across git worktrees from one IDE sidebar.

Built for developers who use [Claude Code](https://code.claude.com) and want to run multiple agents in parallel without the manual worktree juggling, file conflicts, and merge nightmares.

<!-- ![Grove in action](media/grove-demo.gif) -->

## What It Does

- **Agent teams** — pick a template (Full-Stack, Code Review, Debug Squad, Migration, Rapid Prototype), describe the task, name the team, and confirm. Grove creates an isolated worktree per agent, writes each agent a CLAUDE.md listing the files it owns, and starts every Claude Code session so they run in parallel
- **Base branch selection** — choose which branch to create worktrees from, with all local branches listed (default base branch first)
- **Inline file browsing** — expand any worktree to see its changed files, compared against your configured base branch (`grove.defaultBaseBranch`, `main` by default). Click a file to open a visual side-by-side diff
- **Smart sync indicator** — sync button appears when behind remote, so you know at a glance which branches need pulling. Background `git fetch` keeps counts up to date automatically
- **Pre-merge conflict check** — before merging, the merge report lists files changed on both the base branch and the worktree branch since they diverged, so you can see where a merge is likely to need attention
- **Overlap detection** — while two or more agent sessions are running, file watchers on those worktrees flag any file touched in more than one of them, ranked by severity (conflict / warning / info). Watching covers root level files and the common source directories (`src`, `lib`, `app`, `test`, `tests`, `pkg`, `cmd`, `internal`, `config`, `public`, `assets`, `scripts`)
- **Merge sequencing** — pick a target branch from your local branches, and Grove merges the selected worktree branches in an infrastructure first order (types and models, then core and utils, then API, then UI, then tests), opens conflicting files with VS Code's inline conflict markers for you to resolve, runs your test command after each merge when one is configured or detected, and offers to push once the sequence finishes
- **Clean `.gitignore` management** — worktree paths are auto-committed to `.gitignore` on creation and cleaned up on deletion, keeping your base branch always clean
- **Live dashboard** — WebView panel with two-column session cards, file activity grouped by directory with clickable diffs, and overlap alerts. Agent teams are saved to `.grove/teams.json` and reappear in the sidebar after a restart, marked stopped, without reconnecting their terminals
- **Worktree management** — create, monitor, sync, diff, and clean up worktrees without leaving your editor. Diff views show full syntax highlighting on both sides
- **Nested repo support** — works even when your workspace root isn't a git repo. Grove scans the workspace folder's immediate subdirectories, uses the repo it finds, and asks you to choose when there are several. Once Grove has a repo, `Grove: Select Git Repository` switches to a different one or browses for a folder
- **Clear error messages** — the common git failures (git missing, locked index, branch already checked out, no tracking branch, merge conflicts, disk full) are rewritten in plain English with a suggested fix. Anything Grove does not recognise falls back to git's own message

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
| `Grove: Launch Agent Team` | Launch a team of parallel agents from a template |
| `Grove: Open Dashboard` | Open the real-time monitoring dashboard |
| `Grove: Generate Merge Report` | Analyze all worktrees for merge readiness |
| `Grove: Execute Merge Sequence` | Guided sequential merge with test gates |
| `Grove: Check File Overlaps` | Scan for files modified in multiple worktrees |
| `Grove: Cleanup Stale Worktrees` | Batch remove worktrees with confirmation |
| `Grove: Stop All Sessions` | Stop all running Claude Code sessions |
| `Grove: Select Git Repository` | Switch which git repo Grove operates on |
| `Grove: Show All Grove Commands` | Quick menu of Grove's main commands, also on the status bar |

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

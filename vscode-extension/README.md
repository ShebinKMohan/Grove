# Grove — Merge Control for Parallel Claude Code Agents

> Run several Claude Code agents at once and see where they collide before you merge.

Built for developers who run several [Claude Code](https://code.claude.com) agents on one repository. Each agent works in its own git worktree, Grove shows you when two of them touch the same file while they are still working, and it merges their branches back in a guided sequence.

<!-- ![Grove in action](media/grove-demo.gif) -->

## What It Does

- **Agent teams** — pick a template (Full-Stack, Code Review, Debug Squad, Migration, Rapid Prototype), describe the task, name the team, and confirm. Grove creates a worktree per agent and writes each agent's role, task and the files it owns to `.grove/agents/`, outside every worktree, where git never sees it. It then opens a Claude Code session in each worktree with those instructions appended to the system prompt (`--append-system-prompt`). Your project's own CLAUDE.md is never overwritten. Each session waits for your first message before it starts work
- **Base branch selection** — choose which branch to create worktrees from, with all local branches listed (default base branch first)
- **Inline file browsing** — expand any worktree to see its changed files, compared against your configured base branch (`grove.defaultBaseBranch`, `main` by default). Click a file to open a visual side-by-side diff
- **Smart sync indicator** — sync button appears when behind remote, so you know at a glance which branches need pulling. Background `git fetch` keeps counts up to date automatically
- **Pre-merge conflict check** — before merging, Grove merges the selected branches in memory with `git merge-tree`, one after another in the order it will merge them, and lists the files git reports as conflicting, with the earlier branches (or the base branch) that also changed them. Two agents that changed the same lines are caught even when the base branch has not moved. The check runs in your main checkout, so merge settings in `.gitattributes` apply as in the real merge, and nothing in your checkout, index or branches changes. The report also lists files changed on both the base branch and a worktree branch since they diverged
- **Overlap detection** — while two or more agent sessions are running, file watchers on those worktrees flag files touched in more than one of them. Each overlap gets a label from the file's name and path: `info` for shared config such as `package.json` or lockfiles, `warning` for paths containing `types` or `index.` and `.d.ts` files, and `conflict` for everything else. Grove does not compare the two versions' contents. Watching covers root level files and the common source directories (`src`, `lib`, `app`, `test`, `tests`, `pkg`, `cmd`, `internal`, `config`, `public`, `assets`, `scripts`)
- **Merge sequencing** — pick a target branch from your local branches, and Grove merges the selected worktree branches in an infrastructure first order (types and models, then core and utils, then API, then UI, then tests). First it commits each worktree's uncommitted changes. New files the agents created are listed so you choose which ones to include; unchecked files stay in their worktree. It opens conflicting files with VS Code's inline conflict markers for you to resolve, and stages only those files when you continue. It runs your test command after each merge when one is configured or detected. If the tests fail you choose to continue or stop; stopping does not undo the merge just made. It offers to push once the sequence finishes
- **Cleanup that keeps unmerged work** — after a merge, cleanup removes the merged worktrees and their branches. A worktree that still holds files that were not committed or merged is kept, unless you confirm deleting them after seeing the list
- **Local ignore rules, no commits** — Grove keeps its worktree folders and its `.grove/` state out of `git status` by adding them to `.git/info/exclude`, which git never commits. Creating or deleting a worktree makes no commit and leaves your `.gitignore` and staged files alone
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
| `Grove: Execute Merge Sequence` | Guided sequential merge, with tests run between merges |
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
| `grove.enableAgentTeams` | `true` | On team launch, set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `~/.claude/settings.json` (see Known issues) |
| `grove.templateDirectory` | `.grove/templates` | Directory for team templates |
| `grove.testCommand` | `""` | Test command to run after each merge (auto-detected if empty) |
| `grove.showTokenEstimates` | `true` | Show the template's token estimate before launching a team |
| `grove.fileWatcherDebounce` | `500` | Debounce interval (ms) for file change events |
| `grove.notifyOnSessionComplete` | `true` | Notify when a session completes |
| `grove.autoGitignore` | `true` | Keep worktree folders out of `git status` through `.git/info/exclude` (nothing is committed) |
| `grove.showStatusBarItem` | `true` | Show worktree info in the status bar |
| `grove.protectedBranches` | `["main","master","develop","production"]` | Branches that cannot be deleted |

## What Grove Changes on Your Machine

- **Activation and background fetch.** Grove activates in any workspace that contains a `.git` folder. While it is active it runs `git fetch --all --prune` every 60 seconds (every 30 seconds while sessions are running) so the sync indicators stay current.
- **Files in your repository.** Worktrees go under `.claude/worktrees/` (`grove.worktreeLocation`). Session, team and agent-instruction files go under `.grove/`. Both are listed in `.git/info/exclude`.
- **Commits.** Grove commits only in agent worktrees, right before a merge ("Grove: auto-commit agent changes"). The merge sequence checks out the target branch in your main checkout and merges with `git merge --no-edit`. The pre-merge conflict check writes temporary commit objects that no branch points to; git's garbage collection removes them.
- **Dependencies.** After creating a worktree, Grove installs its dependencies (`grove.autoInstallDependencies`, on by default).
- **Claude Code settings.** See Known issues.

## Known Issues

- **Conflict check limits.** It checks committed work: Execute Merge Sequence commits each worktree first, but `Grove: Generate Merge Report` on its own does not see uncommitted changes. After a branch predicted to conflict, later branches are checked without it, because its result depends on how you resolve the conflict. A branch git cannot check (for example one with unrelated history) is listed as not checked. It needs Git 2.38 or later; with older Git, Grove says the check could not run and only the file-level checks run.
- **Global Claude Code settings.** When a team launches and `grove.enableAgentTeams` is on (the default), Grove writes `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` into your global `~/.claude/settings.json` if it is not already set. Set `grove.enableAgentTeams` to `false` to stop this.
- **Session status is inferred.** A session shows as active until its terminal closes; Grove cannot yet tell whether Claude is working or waiting for input.
- **Upgrading from 0.6.0.** Earlier versions committed worktree paths to `.gitignore` and wrote a CLAUDE.md into each agent worktree. The `.gitignore` lines are left in place. A Grove-generated CLAUDE.md that was not committed is restored before the merge; if a branch already committed one, Grove warns before merging it.

## Documentation

Full reference: [DOCUMENTATION.md](DOCUMENTATION.md)

## Acknowledgements

Grove automates the [manual parallel sessions with git worktrees](https://code.claude.com/docs/en/common-workflows) workflow documented by Anthropic, wrapping it with a visual interface, overlap detection, and a guided merge sequence. Built with Claude Code.

## Feedback & Contributions

Got a bug, feature request, or suggestion? [Open an issue](https://github.com/ShebinKMohan/Grove/issues) on GitHub. Pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and guidelines.

## Disclaimer

Grove is an independent open-source project and is not affiliated with, endorsed by, or officially connected to Anthropic. Claude and Claude Code are trademarks of Anthropic.

## License

MIT

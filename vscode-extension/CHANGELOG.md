# Changelog

## [0.5.0] - 2026-03-17

### Added
- **Pre-merge conflict prediction** — merge report now predicts conflicts against the base branch using `git merge-tree` (exact, Git 2.38+) with a file-overlap heuristic fallback. Shows "Predicted Merge Conflicts" and "Files Changed on Both Base & Branch" sections before you merge
- **Conflict warning before merge execution** — executing a merge sequence now runs conflict prediction first and shows a modal warning with the conflicting files, with options to proceed, view the full report, or cancel
- **Push to Remote button** — cloud-upload icon appears on worktrees that are ahead of remote. Pushes with `-u` flag to set up tracking. Handles rejected pushes with helpful messaging
- **Refresh fetches remote** — the sidebar Refresh button now runs `git fetch --all --prune` so ahead/behind counts are up to date and sync/push buttons appear correctly
- **`.gitignore` auto-management** — worktree paths are now committed to `.gitignore` immediately on creation and removed + committed on deletion, keeping the base branch always clean
- **Nested git repo detection** — if the workspace root is not a git repo, Grove scans subdirectories and auto-selects (or lets user pick) the correct repo
- **Select Repository command** — `Grove: Select Git Repository` lets users manually switch which repo Grove operates on, with a folder browser option. Persists across restarts
- **Auto-refresh sidebar** — sidebar refreshes every 60s (30s when sessions active) so worktree status stays current without manual refresh. Existing worktrees now appear immediately on activation
- **Dashboard tab icon** — dashboard panel shows the Grove icon instead of the default generic icon

### Changed
- **Dashboard layout** — session cards now use a two-column grid layout instead of a single column, making better use of space when monitoring multiple sessions
- **File Activity redesigned** — replaced the raw chronological event log with a directory-grouped summary view: files are grouped by directory in a collapsible tree, each file shown once with its latest status (+/~/−) and an edit count badge. Noise files (`.tmp.*`, `.swp`, `.DS_Store`) are automatically filtered out
- **Clickable file activity** — clicking any file in the Activity tab opens VS Code's diff editor comparing the base branch version against the current worktree version
- **File activity persists across reload** — changes are now buffered on the extension side and replayed when the dashboard reconnects, so reloading the panel no longer clears the activity history
- **Sync button conditional visibility** — the "Sync from Remote" button now only appears on worktrees that are behind the remote, acting as a visual indicator that a sync is needed
- **Push button conditional visibility** — the "Push to Remote" button only appears on worktrees that are ahead of the remote
- **Session launch streamlined** — removed the task description prompt from the Claude Code launch flow. Sessions start immediately. Users can still set a task description later via right-click → "Set Task Description"
- **Removed elapsed timer** — the wall-clock timer on session cards and sidebar was misleading (it counted time even when Claude was idle). Removed from dashboard cards, sidebar descriptions, and tooltips
- **Completed sessions deduplicated** — dashboard shows only the most recent completed session per worktree instead of accumulating duplicates
- **View Changes on main** — now shows uncommitted and staged changes only, instead of a meaningless `main...HEAD` diff
- **View Changes on deleted worktree** — shows a warning message instead of a terminal error when the directory no longer exists
- **Noise files filtered from sidebar** — `node_modules/`, `dist/`, `.vite/`, `__pycache__/`, `.next/`, `.nuxt/`, `coverage/`, `.cache/` files are hidden from the changed files list

### Removed
- **"Show in Explorer" / "Hide from Explorer"** — removed the workspace folder integration that caused VS Code to switch to multi-root workspace mode ("UNTITLED (WORKSPACE)"). Worktrees can still be accessed via "Open in New Window" or "Open in Terminal"

## [0.3.1] - 2026-03-15

### Fixed
- **Activity feed spam** — git temp files (`.git`, `.lock`, `.orig`, `.swp`, `.tmp`) now filtered out of file watchers; consecutive changes to the same file are collapsed with an `x N` repeat badge instead of flooding the feed
- **View Changes showing empty** — now shows uncommitted (working tree) and staged changes alongside committed diffs, so in-progress Claude work is visible
- **Sidebar session timer stuck** — added 30-second periodic refresh while sessions are active so elapsed time keeps ticking
- **Interrupted 0-second sessions lingering** — sessions restored from persistence with no duration are now silently dropped instead of cluttering the Completed section

### Added
- **"Clear" button in dashboard** — Completed section now has a Clear button to remove finished sessions

## [0.3.0] - 2026-03-15

### Added
- **Base branch picker** — worktree creation now asks which branch to create from, showing all local branches sorted by most recent (default base branch first, current branch second)
- **Inline file browsing** — worktree items in the sidebar are now expandable, showing all changed files (committed + uncommitted) with color-coded git status icons (added/modified/deleted/renamed)
- **Inline diff view** — clicking a modified file opens VS Code's side-by-side diff editor comparing the base branch version against the current worktree version
- **Show in Explorer** — new "Show in Explorer" context menu action adds a worktree as a workspace folder in VS Code's Explorer for full file management (create, edit, rename, delete files)
- **Hide from Explorer** — companion action to remove a worktree from the workspace
- **Claude Code detection** — pre-flight check before launching sessions; shows install instructions with "Retry" button if `claude` CLI is not found
- **Comprehensive error handling** — every error shown to users now includes what went wrong and how to fix it; `formatErrorForUser()` pattern-matches 15+ common failure scenarios (git not installed, repo locked, permission denied, disk full, branch conflicts, etc.)
- **Graceful activation failures** — if the extension can't activate (no folder open, not a git repo, git not installed, unexpected crash), all commands show a helpful error message instead of VS Code's cryptic "command not found"
- `removeFromGitignore()` — worktree entries are now automatically cleaned from `.gitignore` when a worktree is deleted
- `listLocalBranches()` git utility for branch picker
- `getChangedFilesWithStatus()` returns file status (added/modified/deleted/renamed) alongside paths
- `grove-git:` URI scheme and `TextDocumentContentProvider` for rendering base-branch file contents in diff views

### Changed
- **Delete worktree dialog** — buttons now read "Delete Worktree Only" and "Delete + Local Branch" (was ambiguous "Delete + Branch")
- **Cleanup wizard** — now reports which specific worktrees failed to remove instead of silently swallowing errors
- **Merge error messages** — `humanizeMergeError()` translates raw git merge errors (unrelated histories, lock files, missing branches, etc.) into plain English
- **Git error stripping** — `fatal:` and `error:` prefixes are stripped from git stderr before display
- **Sync error messages** — "no tracking information" and "rebase conflict" errors now include fix instructions
- **Team launch errors** — worktree creation failures during team launch use `formatErrorForUser()` instead of raw error messages
- **Agent Teams env var** — failure to set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` now warns the user instead of silently failing
- **Template parse errors** — invalid template files are now logged with filename and reason instead of silently skipped

### Fixed
- Extension activation crash when workspace is not a git repo — commands were never registered, causing "command not found" errors
- Silent failure when `launchClaude()` returned undefined (Claude not installed)
- Silent failure in overlap detector scan — errors now logged
- Silent failure in session tracker file list refresh — errors now logged
- Silent failure in branch deletion during worktree removal — errors now logged

### Removed (dead code cleanup)
- Unused error classes: `ClaudeNotFoundError`, `GitNotFoundError`, `NotAGitRepoError`, `MergeConflictError`, `SessionLimitError` (replaced by `formatErrorForUser()` pattern matching)
- Unused `isClaudeInstalled()` function
- Unused `MergeResult` interface
- Unused `_repoRoot` parameter from `generateMergeReport()`
- Reduced export surface: 20+ internal-only symbols changed from `export` to module-private

## [0.2.4] - 2026-03-15

### Added
- Sync from Remote button (cloud-download icon) on every worktree in sidebar
- Ahead/behind remote indicators (`↓3 ↑1`) in worktree descriptions
- Behind-remote warning before launching Claude — offers Sync & Continue, Continue Anyway, or Cancel
- Auto-dismiss for all fire-and-forget notifications (8s info/warning, 12s errors, 20s merge recovery)
- `showAutoError` helper for consistent error notification auto-dismiss
- CONTRIBUTING.md with dev setup, project structure, and PR guidelines
- GitHub issue templates for bug reports and feature requests
- CHANGELOG.md at repo root (was only in vscode-extension)
- Claude Code Compatibility section in DOCUMENTATION.md
- `pipenv` added to package manager settings enum
- `pricing: "Free"` for marketplace compliance
- `galleryBanner`, `author`, `homepage`, `bugs` fields for marketplace
- PNG icon (128x128+) for marketplace requirement

### Changed
- Branding updated to "Grove — Worktree Control for Claude Code"
- GitHub repository URLs updated to ShebinKMohan/Grove
- Publisher set to ShebinMohanK
- CLAUDE.md generator now adds IMPORTANT/YOU MUST priority note and emphasis markers
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var value corrected from `"true"` to `"1"` per Claude Code docs
- `git pull --rebase --autostash` used for sync (handles uncommitted changes safely)
- DOCUMENTATION.md included in VSIX (was previously excluded)
- Removed stale legacy references in source comments

### Fixed
- Pressing Escape on task description prompt no longer spawns a Claude session
- `fs.realpathSync` crash on deleted worktree paths — now wrapped in try/catch
- `cancelLaunch` now stops already-spawned sessions before cleaning up worktrees
- `stopAgent` correctly marks team as "stopped" (not "completed") when agents are manually stopped
- `restoreTeams` preserves completed/error/cancelled status instead of overriding to "stopped"
- `endedAt` now persisted and restored for teams
- "Open Terminal" after test failure now pauses with Continue/Abort dialog instead of silently continuing
- Error dialog dismissal (Escape) now shows recovery hash instead of silently breaking
- Unresolved-conflict dialog dismissal treated as abort (not "resolved")
- `saveAll` moved after session stop check (no side effects if user cancels merge)

(0.2.1–0.2.3 were display name and branding updates only)

## [0.2.0] - 2026-03-14

### Added
- One-click agent team launch with 5 built-in templates (Full-Stack, Code Review, Debug Squad, Migration, Rapid Prototype)
- Per-agent CLAUDE.md generation with IMPORTANT/YOU MUST ownership enforcement
- Cancellable team launch with full cleanup on cancel
- Launch guard preventing concurrent team launches
- Team state persistence across VS Code restarts (`.grove/teams.json`)
- Real-time file overlap detection across worktrees with severity classification
- Merge sequencer with pre-merge safety checks, abort recovery, and test gates
- Session dashboard (WebView) with agent cards, file activity feed, and overlap alerts
- Sync from Remote button on every worktree (git pull --rebase --autostash)
- Ahead/behind remote indicators in sidebar
- Behind-remote warning before launching Claude in outdated worktrees
- Auto-dismiss notifications (8s info/warning, 12s errors, 20s merge recovery)
- Quick Menu via status bar
- Session persistence across VS Code restarts (`.grove/sessions.json`)
- Protected branches configuration

### Changed
- Renamed from previous name to Grove
- Config directory changed from `.worktreepilot/` to `.grove/`
- All command prefixes changed from `worktreePilot.` to `grove.`
- Auto-commit before merge now uses `git add -u` (tracked files only) instead of `git add -A`
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var set to `"1"` (per Claude Code docs)

## [0.1.0] - 2026-03-12

### Added
- Basic worktree creation, deletion, and listing
- Claude Code session launching in worktrees
- Sidebar TreeView with worktree status

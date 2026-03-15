# Changelog

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

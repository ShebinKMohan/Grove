# Changelog

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
- Renamed from WorkTree Pilot to Grove
- Config directory changed from `.worktreepilot/` to `.grove/`
- All command prefixes changed from `worktreePilot.` to `grove.`
- Auto-commit before merge now uses `git add -u` (tracked files only) instead of `git add -A`
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var set to `"1"` (per Claude Code docs)

## [0.1.0] - 2026-03-12

### Added
- Basic worktree creation, deletion, and listing
- Claude Code session launching in worktrees
- Sidebar TreeView with worktree status

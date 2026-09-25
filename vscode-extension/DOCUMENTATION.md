# Grove — Merge Control for Parallel Claude Code Agents

> **Version:** 0.6.1
> **Type:** VS Code / Cursor Extension
> **License:** MIT

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [What Grove Is](#what-grove-is)
3. [The Bridge — How It Connects Everything](#the-bridge)
4. [Architecture Overview](#architecture-overview)
5. [Installation & Setup](#installation--setup)
6. [UI Reference — Icons, Views & Controls](#ui-reference)
7. [Complete User Flow](#complete-user-flow)
8. [Feature Reference](#feature-reference)
   - [Worktree Management](#1-worktree-management)
   - [Session Tracking](#2-session-tracking)
   - [Agent Teams](#3-agent-teams--template-based-launch)
   - [Overlap Detection](#4-overlap-detection--safety-layer)
   - [Merge Sequencer](#5-merge-sequencer--guided-merge)
   - [Dashboard](#6-dashboard)
9. [Built-in Team Templates](#built-in-team-templates)
10. [Configuration Reference](#configuration-reference)
11. [Project-Level Configuration](#project-level-configuration)
12. [Claude Code Compatibility](#claude-code-compatibility)
13. [Tips for Efficient Usage](#tips-for-efficient-usage)
14. [Troubleshooting](#troubleshooting)

---

## Problem Statement

AI-powered coding tools like Claude Code can now write real, production-quality code. But there is a fundamental bottleneck: **they work sequentially, one task at a time, in a single directory.**

When you have a feature that spans backend, frontend, and tests — you either wait for one agent to do it all, or you manually juggle multiple terminals, worktrees, and branches while praying that two agents don't edit the same file.

**The real problems:**

| Problem | What Happens Today |
|---|---|
| **No parallelism** | You can only run one Claude Code session per directory. Switching tasks means stopping work. |
| **No isolation** | Two agents writing code in the same directory create conflicts, overwrite each other's changes, and produce corrupted state. |
| **No visibility** | With multiple agents running, you have no central place to see what each one is doing, which files they're touching, or whether they're stepping on each other's toes. |
| **No guided merge path** | After parallel work, merging branches back together is manual, error-prone, and has no guidance on order or conflicts. |
| **No team coordination** | Splitting one feature across several agents means creating a worktree per agent, writing each one's role and file boundaries, and starting every session by hand. |

**The result:** Developers avoid parallel AI development altogether, or attempt it manually and lose hours to merge conflicts and coordination overhead.

---

## What Grove Is

Grove is the **control plane for parallel AI development**. It wraps git worktrees and Claude Code sessions into a single, IDE-native experience.

Think of it as **"Docker Desktop for AI coding agents"** — you don't replace Claude Code, you wrap it with visibility, overlap alerts, and a guided team launch and merge.

**What it does:**
- Creates isolated git worktrees so multiple Claude Code sessions run in parallel without interfering
- Launches and tracks Claude Code sessions across all worktrees from one sidebar
- Launches a team of agents from a pre-built template: pick the template, describe the task, name the team, and confirm
- Flags files touched in more than one worktree while the agents are still working
- Guides the merge: orders branches by the paths they changed, commits each worktree's work first, and opens conflicting files for you to resolve

**What it does NOT do:**
- It does not replace Claude Code — it orchestrates it
- It does not make API calls to Anthropic — it only spawns `claude` CLI processes in terminals
- It does not bundle any AI model — all AI work happens through your existing Claude Code installation

---

## The Bridge

Grove bridges three things that currently exist in isolation:

```
┌─────────────────┐     ┌────────────────────┐     ┌─────────────────────┐
│   Git Worktrees  │     │    Claude Code      │     │    Your IDE         │
│                  │     │                     │     │                     │
│  Isolated dirs   │────▶│  AI coding agent    │────▶│  Where you work     │
│  with branches   │     │  in each worktree   │     │  and review code    │
└─────────────────┘     └────────────────────┘     └─────────────────────┘
         │                        │                          │
         └────────────────────────┼──────────────────────────┘
                                  │
                     ┌────────────▼────────────┐
                     │    Grove        │
                     │                         │
                     │  • Creates worktrees    │
                     │  • Spawns sessions      │
                     │  • Watches for overlaps │
                     │  • Sequences merges     │
                     │  • Shows it all in one  │
                     │    unified sidebar      │
                     └─────────────────────────┘
```

**Without Grove:**
```
Terminal 1:  git worktree add .claude/worktrees/backend -b feat-backend
Terminal 2:  git worktree add .claude/worktrees/frontend -b feat-frontend
Terminal 3:  cd .claude/worktrees/backend && claude
Terminal 4:  cd .claude/worktrees/frontend && claude
Terminal 5:  # Manually check if they edited the same files
Terminal 6:  git merge feat-backend && git merge feat-frontend  # hope for the best
```

**With Grove:**
```
Sidebar:  Click "+" → name it → worktree created
Sidebar:  Click rocket icon → Claude launches in it
Dashboard: See all sessions, files changed, overlaps
Sidebar:  Click the "Generate Merge Report" hint → see changes and overlaps per branch
Palette:  "Grove: Execute Merge Sequence" → guided sequential merge
```

---

## Architecture Overview

```
grove/
├── src/
│   ├── extension.ts                         # Entry point — registers commands, views, lifecycle
│   ├── core/
│   │   ├── worktree-manager.ts              # Git worktree CRUD + health checks
│   │   ├── session-tracker.ts               # Terminal session lifecycle + persistence
│   │   ├── agent-orchestrator.ts            # Team launch + agent lifecycle
│   │   ├── overlap-detector.ts              # Real-time cross-worktree overlap detection
│   │   ├── merge-sequencer.ts               # Merge analysis, ordering, execution
│   │   ├── template-manager.ts              # Team template loading + validation
│   │   ├── claude-md-generator.ts           # Per-agent instructions files (.grove/agents/)
│   │   ├── gitignore.ts                     # Local ignore rules in .git/info/exclude
│   │   └── config-manager.ts                # Project-level config read/write
│   ├── ui/
│   │   ├── sidebar/
│   │   │   └── unified-tree-provider.ts     # Single hierarchical sidebar TreeView
│   │   └── webview/
│   │       └── dashboard-panel.ts           # React dashboard WebView manager
│   └── utils/
│       ├── git.ts                           # Git command wrapper with write mutex
│       ├── terminal.ts                      # Terminal creation + Claude launcher
│       ├── claude-command.ts                # Builds the `claude` command line
│       └── package-manager.ts               # Auto-detect npm/yarn/pnpm/pip/poetry
├── webview-ui/                              # React app for dashboard (built with Vite)
├── templates/                               # 5 built-in team templates (JSON)
└── package.json                             # Extension manifest
```

**Key design decisions:**
- Most core modules (worktrees, merge, templates, ignore rules, agent instructions, config) have no VS Code dependency — they work with plain git and filesystem
- Git write operations are serialized through a mutex to prevent lock conflicts
- File watchers are debounced (500ms default) to handle rapid AI agent writes
- State persists to `.grove/sessions.json` across VS Code restarts
- WebView communicates with the extension via typed message passing

---

## Installation & Setup

### Prerequisites
- **VS Code** 1.85+ or **Cursor** (any recent version)
- **Git** installed and available in PATH
- **Claude Code** CLI installed (`claude` command available in terminal)
- A git repository to work in

### Install the Extension
```bash
code --install-extension ShebinMohanK.grove-pilot
```

### First Launch
1. Open any git repository in VS Code / Cursor
2. The Grove icon appears in the Activity Bar (left sidebar)
3. Click it to open the sidebar — you'll see the welcome screen with quick-start buttons
4. The status bar (bottom) shows the current branch and worktree count (e.g. `$(git-branch) main | 3 wt`); click it for the quick menu

No additional configuration is needed. The extension auto-detects your git setup, package manager, and test commands.

### Nested Repository Support
If your workspace root is not a git repository (e.g., a parent folder containing multiple projects):
- Grove automatically scans immediate subdirectories for git repos
- If one repo is found, it's used automatically
- If multiple repos are found, a picker lets you choose which one to use
- Your selection persists across VS Code restarts
- To switch later, run `Grove: Select Git Repository` from the Command Palette

### Auto-Refresh
The sidebar refreshes automatically:
- Every **30 seconds** when Claude Code sessions are active
- Every **60 seconds** when idle
- Existing worktrees appear immediately on activation without needing a manual refresh
- The Refresh button also runs `git fetch` so ahead/behind counts update

---

## UI Reference

### Activity Bar Icon

| Icon | Location | Purpose |
|------|----------|---------|
| Layers icon (custom SVG) | Activity Bar (left edge) | Opens the Grove sidebar |

### Sidebar Title Bar Buttons

Four buttons appear at the top of the sidebar view:

| Position | Icon | Command | Purpose |
|----------|------|---------|---------|
| 1st | `$(add)` **+** | Create Worktree | Create a new isolated worktree |
| 2nd | `$(organization)` **team** | Launch Agent Team | Deploy a team from templates |
| 3rd | `$(dashboard)` **grid** | Open Dashboard | Open the real-time monitoring dashboard |
| 4th | `$(refresh)` **arrows** | Refresh | Manually refresh the sidebar state |

### Sidebar Tree Items

The sidebar uses a single unified tree with these node types:

| Icon | Color | Node Type | What It Represents |
|------|-------|-----------|--------------------|
| `$(add)` | Green | Workflow Hint (create) | "Create a worktree to get started" |
| `$(rocket)` | Blue | Workflow Hint (launch) | "Launch Claude Code in your worktrees" |
| `$(pulse)` | Green | Workflow Hint (running) | "N sessions running — Open Dashboard" |
| `$(check-all)` | Purple | Workflow Hint (done) | "All done — Generate Merge Report" |
| `$(dash)` | Grey | Divider | Visual separator between hint and workspace |
| `$(organization)` | Green | Active Team | A running Agent Team |
| `$(loading~spin)` | Yellow | Launching Team | Team currently being set up |
| `$(pass)` | Blue | Completed Team | Team that finished all work |
| `$(error)` | Red | Error Team | Team with errors |
| `$(debug-stop)` | Grey | Stopped Team | Manually stopped team |
| `$(repo)` | Blue | Main Worktree | Your default working directory |
| `$(git-branch)` | Default | Clean Worktree | Worktree with no pending changes |
| `$(git-branch)` | Yellow | Dirty Worktree | Worktree with uncommitted changes |
| `$(git-branch)` | Green | Active Worktree | Worktree with a running session |
| `$(git-merge)` | Red | Conflict Worktree | Worktree with merge conflicts |
| `$(warning)` | Red | Missing Worktree | Worktree directory not found on disk |
| `$(play-circle)` | Green | Active Session | Claude Code session whose terminal is open |
| `$(watch)` | Yellow | Idle Session | Reserved — Grove does not detect idle sessions yet, so this icon does not appear |
| `$(check)` | Blue | Completed Session | Finished Claude Code session (shown in the Completed view) |
| `$(close-dirty)` | Red | Error Session | Session whose terminal exited with a non-zero code |

Finished sessions and teams are listed in a separate, collapsed **Completed** view below the main Grove view.

**Agent icons** (inside teams):

| Icon | Color | Status |
|------|-------|--------|
| `$(circle-outline)` | Grey | Pending — not yet launched |
| `$(loading~spin)` | Yellow | Launching — worktree being created |
| `$(sync~spin)` | Green | Active — Claude session running |
| `$(pass)` | Blue | Completed — agent finished |
| `$(error)` | Red | Error — agent failed |
| `$(debug-stop)` | Grey | Stopped — manually stopped |

### Sidebar Context Menus (Right-Click)

**On a worktree:**
- `$(rocket)` Launch Claude Code — start a Claude session
- `$(terminal)` Open in Terminal — open a plain terminal
- `$(multiple-windows)` Open in New Window — open in separate VS Code window
- `$(trash)` Delete Worktree — remove the worktree, optionally with its branch

**On an active session:**
- `$(terminal)` Open Session Terminal — bring terminal to focus
- `$(debug-stop)` Stop Session — close the terminal

**On an active team:**
- `$(debug-stop)` Stop Team — stop all agents
- `$(trash)` Cleanup Team Worktrees — remove all team worktrees and their branches

**On a completed team:**
- `$(trash)` Cleanup Team Worktrees — remove all team worktrees and their branches

**On an active agent:**
- `$(terminal)` Open Agent Terminal — bring agent's terminal to focus
- `$(debug-stop)` Stop Agent — close the agent's terminal

**On the "Completed" view title bar:**
- `$(clear-all)` Clear Completed Sessions — remove finished sessions from list

### Worktree Description Format

Each worktree shows inline status after its branch name:

```
main · default                          # Main worktree
feat-backend · wt-backend · ~3 +2      # 3 modified, 2 staged
feat-frontend · wt-frontend · clean    # No changes
```

Change indicators: `!N` conflicts, `+N` staged, `~N` modified, `?N` untracked

### Status Bar

| Icon | Location | Action |
|------|----------|--------|
| `$(git-branch)` branch · worktree count (plus `$(rocket)` active session count) | Bottom status bar | Opens a quick menu of the main Grove commands |

### Dashboard Tabs

The dashboard opens as a WebView tab with three sections:

| Tab | Badge | Content |
|-----|-------|---------|
| Sessions | — | Active and completed agent cards in a two-column grid with file counts and actions |
| Activity | — | Directory-grouped file summary with clickable diffs, noise filtered |
| Overlaps | Count | List of files modified in multiple worktrees, sorted by severity |

### Dashboard Session Cards

Each card shows:
- Agent/branch name with status indicator (colored left border)
- Task description (if set)
- Files modified count (badge)
- Start time (and end time once the session has finished)
- Action buttons: Open Terminal, View Changes, Stop Session

---

## Complete User Flow

This is the recommended end-to-end workflow, from setup to merged code.

### Flow 1: Solo Worktree (Single Agent)

Best for: focused single-task work where you want isolation from main.

```
Step 1 ─ Create Worktree
  Sidebar: Click "+" (top bar)
  → Pick the base branch (e.g., "main")
  → Enter the new branch name (e.g., "add-auth")
  → Worktree created at .claude/worktrees/add-auth/
  → Dependencies auto-installed
  → Branch: add-auth

Step 2 ─ Launch Claude Code
  Sidebar: Click rocket icon on the worktree
  → Terminal opens in the worktree directory
  → Claude Code starts with a clean session
  → Give Claude your task prompt

Step 3 ─ Monitor
  Sidebar: Workflow hint shows "1 session running — Open Dashboard"
  Dashboard: See files being modified in real-time
  Sidebar: Session appears as child of the worktree with status

Step 4 ─ Review
  Sidebar: Expand worktree → click any changed file
  → Opens VS Code's visual side-by-side diff editor

Step 5 ─ Merge
  Command Palette: "Grove: Generate Merge Report"
  → Review file counts, changes summary
  Command Palette: "Grove: Execute Merge Sequence"
  → Commits the worktree's tracked changes, plus the new files you tick
  → Merges into the target branch you picked (e.g., main)
  → Runs tests (if configured or detected)

Step 6 ─ Cleanup
  Sidebar: Right-click worktree → "Delete Worktree"
  → Worktree removed (and its branch, if you choose "Delete + Local Branch")
```

### Flow 2: Agent Team (Multi-Agent Parallel)

Best for: full features spanning backend + frontend + tests, or multi-perspective code reviews.

```
Step 1 ─ Launch Team
  Sidebar: Click team icon (top bar)
  → Select template (e.g., "Full-Stack Team")
  → Enter task description (detailed prompt for all agents)
  → Enter team name (e.g., "login-feature")
  → Pre-flight check shows overlap analysis (if ownership overlaps)
  → Click "Continue Anyway" (or fix ownership first)
  → Confirm launch (shows worktree count + estimated tokens)

Step 2 ─ Worktrees Created Automatically
  Extension creates:
    .claude/worktrees/worktree-login-feature-backend/
    .claude/worktrees/worktree-login-feature-frontend/
    .claude/worktrees/worktree-login-feature-tests/
    .claude/worktrees/worktree-login-feature-reviewer/
  Each agent gets a tailored instructions file in .grove/agents/
  (outside the worktree; nothing is written into it) with:
    - Role and responsibilities
    - File ownership boundaries
    - Shared files protocol (when .grove/config.json lists sharedFiles)
    - The task description

Step 3 ─ Sessions Launch
  4 terminals open, each running Claude Code with its
  agent's instructions appended to the system prompt
  → Each session waits for your first message: type one
    (e.g., "Start") in each terminal — the task is already
    in the instructions
  → Agents work in parallel, isolated from each other
  Dashboard auto-opens showing all 4 agent cards

Step 4 ─ Monitor in Real-Time
  Dashboard → Sessions tab:
    See all 4 agents with start times and file counts
  Dashboard → Activity tab:
    See every file change across all worktrees as it happens
  Dashboard → Overlaps tab:
    Get alerted if two agents modify the same file

Step 5 ─ Handle Overlaps (if any)
  If the Overlaps tab lists files (the label comes from the file's
  name and path only; contents are not compared):
    - Red (conflict): any file not covered by the two rules below
    - Yellow (warning): paths containing "types" or "index.", or ending in .d.ts
    - Blue (info): shared config files like package.json → often expected
  Actions: "Dismiss", "Dismiss All"

Step 6 ─ Generate Merge Report
  When workflow hint says "All done — Generate Merge Report":
  Command Palette: "Grove: Generate Merge Report"
  → Shows per-agent stats: files changed, lines added/removed
  → Shows overlapping files with resolution guidance
  → Shows recommended merge order (types → core → API → UI → tests)

Step 7 ─ Execute Merge Sequence
  Command Palette: "Grove: Execute Merge Sequence"
  → Lists the new (untracked) files in the worktrees for you to tick
  → Commits each worktree's tracked changes plus the ticked files
  → Merges agents in the recommended order (worked out from the
    paths each branch changed), for example:
     1. Backend first (defines models and APIs)
     2. Frontend next (consumes APIs)
     3. Tests last (tests the integrated code)
  → If conflict: pauses, shows conflict details, lets you resolve
  → If tests are configured or detected: runs after each merge step

Step 8 ─ Cleanup
  Sidebar: Right-click team → "Cleanup Team Worktrees"
  → All team worktrees and branches removed, including any
    uncommitted or untracked files (the confirmation names the
    worktrees that still have them)
  → Or: Command Palette → "Cleanup Stale Worktrees" for batch cleanup
```

### Flow 3: Code Review Team (Read-Only)

Best for: getting multi-perspective review of existing code.

```
Step 1 ─ Launch "Code Review Team" template
  → 3 read-only agents: Security, Performance, Architecture
  → Each gets instructions telling it to write REVIEW.md, not modify code

Step 2 ─ Each agent writes a REVIEW.md in their worktree
  → Security agent: checks for vulnerabilities, injection risks, auth issues
  → Performance agent: checks for N+1 queries, memory leaks, inefficient algorithms
  → Architecture agent: checks for coupling, patterns, maintainability

Step 3 ─ Read the reviews
  Sidebar: Right-click each worktree → "Open in New Window"
  → Read each REVIEW.md
  → No merge needed — just extract the insights

Step 4 ─ Cleanup
  Sidebar: Right-click team → "Cleanup Team Worktrees"
```

---

## Feature Reference

### 1. Worktree Management

**What:** Full lifecycle management of git worktrees through the sidebar.

**Create Worktree:**
1. **Pick base branch** — QuickPick showing all local branches, sorted by most recent commit. Default base branch (e.g., `main`) listed first, current branch second
2. **Name the new branch** — input box validates against git naming rules. Shows which branch you're branching from
3. Creates at: `.claude/worktrees/<branch-slug>/`
4. Auto-detects package manager (npm/yarn/pnpm/pip/pipenv/poetry) and installs dependencies
5. Adds the worktree path to `.git/info/exclude` (when `grove.autoGitignore` is on); nothing is committed

**File Browsing:**
- Expand any worktree in the sidebar to see all changed files (committed + uncommitted vs base branch). This includes the main worktree — uncommitted/staged changes show up there too
- Each file shows its name, directory path, and change status with color-coded icons:
  - Green `+` for added files
  - Yellow `~` for modified files
  - Red `-` for deleted files
  - Blue `→` for renamed files
- **Click a modified file** to open VS Code's side-by-side diff editor with full syntax highlighting on both sides (base branch vs worktree)
- **Click an added file** to open it directly
- **Safety:** if a file was deleted or renamed since the diff was computed, a warning is shown instead of crashing. New files (not yet on the base branch) open directly instead of showing an empty diff

**Delete Worktree:**
- Safety check: warns if there are uncommitted changes or active sessions
- Options for a clean worktree: "Delete Worktree Only", "Delete + Local Branch", or "Delete + Local & Remote Branch" (the remote option only appears when the branch exists on a remote). A worktree with uncommitted changes gets a single "Force Delete", which also deletes its local branch unless the branch is protected
- Protected branches (main, master, develop, production) cannot be deleted
- Removes the worktree's `.git/info/exclude` rule and its agent instructions file on deletion; `.gitignore` is not touched

**Health Checks:**
- Detects missing worktree directories
- Detects detached HEAD states
- Detects stale `.git/worktrees` lock files
- Detects worktrees with no corresponding branch

**Cleanup Wizard:**
- Lists every worktree except the main one, none pre-selected, for you to pick
- If you also delete branches, only merged branches are deleted (`git branch -d`); a branch with unmerged commits is kept
- Batch delete with confirmation dialog
- Reports which specific worktrees failed to remove (not silent)
- Never deletes a protected branch (the worktree itself is still removed)

**Sync from Remote:**
- The cloud-download icon appears only when a worktree is behind the remote — it acts as a visual indicator
- Runs `git fetch --all --prune` then `git pull --rebase --autostash`
- Auto-stashes uncommitted changes, pulls, then reapplies them; if the rebase or the reapplied changes hit a conflict, git stops and leaves the worktree for you to resolve
- Also available via right-click → "Sync from Remote" (only shown when behind)

**Ahead/Behind Indicators:**
- Each worktree shows `↓3` (behind remote) in the sidebar description
- Counts update automatically via background `git fetch` (every 30s with active sessions, 60s idle) and when you click the Refresh button
- Tooltip shows detailed sync status

**Local Ignore Rules (`.git/info/exclude`):**
- Worktree folders (while `grove.autoGitignore` is on, the default) and `/.grove/` (when Grove creates that folder or writes agent instructions) are added to `.git/info/exclude`, which git reads like a `.gitignore` but never commits. The file is shared by all worktrees of the repository
- Creating or deleting a worktree makes no commit and never edits `.gitignore` or the index; deleting a worktree removes its rule from `.git/info/exclude`
- `.gitignore` lines written by Grove 0.6.0 and earlier are left in place

**Branch Strategy Resolution:**
- If local branch exists: uses it
- If remote branch exists but no local: tracks it
- Otherwise: creates new branch from base

### 2. Session Tracking

**What:** Tracks Claude Code terminal sessions across all worktrees.

**Session Lifecycle:**
1. **Launch** — click rocket icon or "Launch Claude Code" on a worktree
2. **Active** — terminal is open (Grove cannot tell whether Claude is working or waiting for input)
3. **Idle** — reserved; Grove does not detect this state yet, so a session stays Active until its terminal closes
4. **Completed** — terminal closed normally
5. **Error** — terminal closed with a non-zero exit code

**Terminal Styling:**
- Claude Code terminals show a green color and git-branch icon in the terminal tab for easy identification among other terminals

**Session Data:**
- Branch name and worktree path
- Task description (user-settable via right-click → "Set Task Description")
- Modified files list (refreshed via `git diff --name-only`)
- Start time
- Terminal instance reference

**Persistence:**
- Sessions saved to `.grove/sessions.json`
- Restored on VS Code restart (running sessions marked as completed)
- Last 10 completed sessions shown in the "Completed" view in the sidebar

**Notifications:**
- VS Code notification when a session completes with "View Diff" action
- "View Diff" opens VS Code's visual side-by-side diff editor on the first changed file
- Expand worktree in sidebar to browse and diff all changed files

**Existing Session Detection:**
- When launching Claude in a worktree that had a previous session, offers:
  - Continue last session (`claude --continue`)
  - Pick a session from recent conversations (`claude --resume`)
  - New session

**Behind-Remote Warning:**
- Before launching Claude, checks if the worktree branch is behind the remote
- If behind, shows a warning: "'feature-x' is 3 commit(s) behind remote. Pull before starting to avoid conflicts."
- Options: "Sync & Continue" (auto-pulls), "Continue Anyway", or "Cancel"

### 3. Agent Teams — Template-Based Launch

**What:** Launch a team of Claude Code agents from a template, one agent per worktree.

**Pre-Flight Checks:**
Before any worktree is created, the system:
1. Scans ownership patterns across all agents in the template
2. Detects overlapping file ownership (e.g., two agents both owning `src/api/**`)
3. Notes reviewer agents with no ownership (they review the full codebase)
4. Checks concurrent session limits
5. Shows confirmation with worktree count and estimated token cost

**Per-Agent Instructions:**
Each agent gets a tailored instructions file at `.grove/agents/<worktree-folder>-<hash>.md` in the main repository — outside every worktree, so nothing is written into the worktree and its CLAUDE.md is never overwritten. Grove starts Claude Code with this file appended to its system prompt (see [Claude Code Compatibility](#claude-code-compatibility)). The file uses **IMPORTANT** and **YOU MUST** emphasis markers (following Claude Code's own documentation recommendations for improving instruction adherence):

```
# Backend Architect — Grove Agent

> **Team:** Full-Stack Team | **Role:** backend | **Session:** login-feature

**IMPORTANT: These agent-specific instructions take priority over any
project-level CLAUDE.md instructions regarding file ownership and boundaries.
YOU MUST respect the file ownership rules below — do not modify files
outside your assigned ownership patterns.**

## Task
[User's task description]

## Your Role
[Agent's role prompt from template]

## File Ownership
**YOU MUST** focus your work on these file patterns — they are yours:
  - `src/api/**`
  - `src/models/**`
  - `src/services/**`

**IMPORTANT: YOU MUST NOT modify** files owned by other agents:
  - **Frontend Dev** (frontend): `src/components/**`, `src/pages/**`
  - **Test Engineer** (tests): `tests/**`, `src/**/*.test.*`

## Shared Files Protocol
**IMPORTANT:** ... **YOU MUST NOT modify these directly.**
Instead, document changes in SHARED-CHANGES.md.
  - `package.json`
  - `tsconfig.json`

## Handoff Protocol
If you need changes in files you don't own, create HANDOFF.md.

## Project Conventions
[Pulled from .grove/config.json]

## Additional Instructions
[The template's claudeMdExtra for this agent, if any]

## Project-Level Instructions (from main repo)
[Contents of the main checkout's CLAUDE.md — only when the worktree
 has no CLAUDE.md of its own, e.g. because CLAUDE.md is untracked]
```

**Cancellable Launch:**
- The launch process shows a progress notification with a Cancel button
- If cancelled mid-launch, all worktrees (with their branches) and agent instructions files created so far are deleted
- Any sessions already spawned are stopped
- Team status is set to "cancelled"

**Launch Guard:**
- Only one team can be launched at a time — concurrent launches are rejected with a message
- Before launching, active session count is checked against `grove.maxConcurrentSessions`
- If the limit would be exceeded, a warning offers "Proceed" or "Cancel"

**Team Persistence:**
- Team state persists to `.grove/teams.json` (atomic write — crash-safe)
- On VS Code restart, teams with existing worktrees are restored with status "stopped"
- Completed/errored/cancelled teams preserve their original status
- No terminal reconnection is attempted — restart a session manually if needed

**Team Status Sync:**
- Team status automatically updates based on agent session states
- All agents running → team "running"
- All agents done → team "completed"
- Any agent errored → team "error"
- All agents manually stopped → team "stopped" (not "completed")

**Cleanup:**
- Right-click team → "Cleanup Team Worktrees"
- Stops the team's agents, then removes all worktrees and branches created for the team, with their agent instructions files
- The confirmation says that worktrees and branches are deleted and names the worktrees that still have uncommitted or untracked files; those files are deleted too

### 4. Overlap Detection — Safety Layer

**What:** Real-time detection of files modified in more than one worktree.

**How It Works:**
1. While two or more sessions are active, file system watchers monitor their worktree directories
2. Each file change is recorded: `{ filePath → Set<worktreePaths> }`
3. When a file appears in more than one worktree's change set, an overlap is created
4. Overlaps are classified by severity and surfaced in the dashboard

**Severity Levels:**

Severity is chosen from the file's name and path only. Grove does not compare the contents of the two versions, so a "conflict" label does not mean git will report a merge conflict.

| Severity | Color | When | Example |
|----------|-------|------|---------|
| **Conflict** | Red | Any other file modified in multiple worktrees | `src/api/auth.ts` modified by both Backend and Frontend agents |
| **Warning** | Yellow | Path contains `types` or `index.`, or ends in `.d.ts` | `src/types/index.ts` modified by two agents |
| **Info** | Blue | File name is in the shared config list below | `package.json` modified by two agents |

**Shared Config Files** (classified as "info"):
`package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.build.json`, `.env`, `.env.example`, `.env.local`, `.gitignore`, `Makefile`, `Dockerfile`, `docker-compose.yml`, `pyproject.toml`, `requirements.txt`, `go.mod`, `go.sum`, `Cargo.toml`, `Cargo.lock`

**Watched Directories:**
`src/`, `lib/`, `app/`, `test/`, `tests/`, `pkg/`, `cmd/`, `internal/`, `config/`, `public/`, `assets/`, `scripts/`

**Skipped:**
`.git/`, `node_modules/`, `__pycache__/`

**Pre-Flight Overlap Analysis:**
Before launching a team, ownership patterns are analyzed for overlaps:
- Direct overlaps: `src/api/**` assigned to two agents
- Prefix overlaps: `src/**` overlaps with `src/api/**` from different agents
- Warning shown with recommendations to adjust ownership

**Actions on Overlaps:**
- Dismiss — mark as expected/resolved
- Dismiss All — clear all overlap alerts

### 5. Merge Sequencer — Guided Merge

**What:** Guided merge process with analysis, ordering, and execution.

**Merge Report Generation:**
For each worktree, computes:
- Files changed count (both committed and uncommitted)
- Lines added / removed
- New files created
- Full diff stat
- REVIEW.md findings (if reviewer agent wrote one)
- HANDOFF.md notes (if agent flagged cross-team dependencies)

**Pre-Merge Check Against the Target Branch:**
For each worktree branch with changes, the merge report compares it with the target branch you pick:
- "Files Changed on Both Base & Branch" — files changed on both the target branch and the worktree branch since they diverged (a file-overlap heuristic). They may or may not conflict
- Grove also runs `git merge-tree --write-tree` (Git 2.38+), which is meant to list the files that would conflict. In 0.6.1 this check never reports a file: Grove reads git's error message, but `git merge-tree` prints the conflicts on stdout. The report's "Predicted Merge Conflicts" section and the conflict warning before a merge sequence therefore do not appear yet. A fix is planned

**Worktree-to-Worktree Overlap Analysis:**
- Files modified in multiple worktrees identified
- Classification, by file name only (contents are not compared):
  - Likely auto-resolvable: `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`, `Cargo.lock`, `requirements.txt`, `.gitignore`
  - Manual merge needed: every other file

**Merge Order Recommendation:**
Branches are ordered by the paths of the files each one changed; a branch gets the score of the first row below that any of its files matches, or 50 (between UI and tests) if none match. A template's `mergeOrder` is not used yet.

| File Type | Priority | Rationale |
|-----------|----------|-----------|
| Types / models / interfaces | 1st (score 10) | Define contracts other code depends on |
| Core / lib / utils | 2nd (score 20) | Shared utilities used by feature code |
| API / services | 3rd (score 30) | Business logic that consumes models |
| UI / components / pages | 4th (score 40) | Frontend that consumes API |
| Tests | 5th (score 80) | Test the integrated result |
| No changes | Last (score 100) | Nothing to merge |

**Merge Flow Dialogs:**
1. Pick target branch (any local branch, not just main)
2. Select worktree branches to merge (multi-select, all checked; they are merged in the recommended order)
3. Only if sessions are running in those worktrees: "Stop & Merge" / "Cancel"
4. Only if a branch already has a committed CLAUDE.md that Grove 0.6.0 generated: warning with "Merge Anyway" (otherwise the merge is cancelled)
5. Only if the worktrees hold new (untracked) files: a checklist of those files (see Pre-Merge Auto-Commit)

The conflict warning with "Merge Anyway" / "View Report" depends on the `git merge-tree` check above, so it does not appear in 0.6.1.

**Pre-Merge Safety:**
1. Stops active sessions in worktrees being merged (with confirmation)
2. Saves all open VS Code files (`saveAll`)
3. Verifies the main checkout is in a clean state (no uncommitted or untracked files, no in-progress merge/rebase)
4. Sorts branches by recommended merge order (types → core → API → UI → tests)
5. Warns, before any session is stopped, if a branch already has a committed CLAUDE.md that Grove 0.6.0 generated, because merging it would replace the project's CLAUDE.md on the target branch (or add one, if the target has none). A CLAUDE.md symlink, for example to `AGENTS.md`, is followed

**Pre-Merge Auto-Commit:**
Before the first merge, Grove commits the work in each selected worktree:
1. Lists every untracked new file in the selected worktrees (ignored files are skipped) in a multi-select list. Files are pre-checked, except Grove coordination notes at the worktree root (`HANDOFF.md`, `SHARED-CHANGES.md`, `REVIEW.md`, `FINDINGS.md`) and anything under `.claude/`. Unchecked files stay in their worktree. A nested git repository an agent created is never listed or committed. Pressing Escape cancels the merge. Worktrees whose folder no longer exists are skipped with a warning
2. Commits all tracked changes plus the checked new files in each worktree ("Grove: auto-commit agent changes"). A CLAUDE.md that Grove 0.6.0 generated in the worktree is restored first (or removed, if it was never committed) and is never committed
3. If a commit fails (for example, a pre-commit hook rejects it), the sequence stops before any merge and shows the error

**Merge Execution:**
For each worktree in sorted order:
1. Checkout target branch (in the main checkout)
2. Merge the worktree's branch (`git merge <branch> --no-edit`)
3. If conflict: opens up to 5 of the conflicting files with VS Code's inline conflict markers (CodeLens: Accept Current / Incoming / Both)
4. A notification (not a modal dialog, so you can edit the files while it is open) offers "I've Resolved — Continue" / "Skip This Branch" / "Abort All". Closing it without a choice stops the sequence and leaves the merge in progress, undoing nothing
   - "I've Resolved — Continue" first checks the conflicted files for leftover `<<<<<<<` / `>>>>>>>` markers and asks before committing them. It then stages only the conflicted files that are still unmerged (nothing else in the checkout; a file you already resolved with `git rm` or staged yourself is left as it is) and commits the merge. If that commit fails and the merge is still in progress, Grove does not abort it: the merge stays in progress, Grove says which files are still unmerged, tells you to finish it with `git commit` or undo it with `git merge --abort`, and the sequence stops
   - "Skip This Branch" runs `git merge --abort` for this branch and moves on to the next one
   - "Abort All" runs `git merge --abort` for this branch and stops the sequence (see Abort Semantics)
5. If the merge fails for any other reason: runs `git merge --abort`, shows a warning, and moves on to the next branch
6. After a clean or resolved merge: runs tests when `grove.testCommand` is set or a test command is detected (no dialog unless they fail). On failure you choose "Continue Anyway" or "Abort"; stopping does not undo the merge that was just made, and Grove shows the `git reset --hard <hash>` command

**Post-Merge:**
- Summary shows succeeded/failed count
- Actions: "Push to Remote" / "Cleanup Worktrees" / "Done"

**Abort Semantics:**
- Captures the target branch's commit (`git rev-parse <target>`) before the first merge
- Tracks which branches were successfully merged as the loop progresses
- When "Abort All" is clicked, Grove runs `git merge --abort` for the current branch and shows the pre-merge hash: `git reset --hard <hash>` to undo the earlier merges if needed. The summary that follows shows how many branches had already merged
- Previous merges are NOT rolled back automatically — that's a destructive operation left to the user
- Dismissing a prompt never counts as "I've Resolved — Continue" or "Continue Anyway": closing the conflict notification stops the sequence and leaves that merge in progress (nothing is aborted), Escape on the test-failure dialog stops the sequence, and Escape on the dialogs before the first merge cancels

**Post-Merge Cleanup:**
- "Cleanup Worktrees" removes each merged worktree without `--force` and deletes its branch with `git branch -d` (protected branches are kept; if git refuses `-d`, the branch is kept)
- A worktree that still has uncommitted or untracked files is removed only if you confirm "Delete Them" after seeing the list; otherwise it is kept and the summary names it. A CLAUDE.md that Grove 0.6.0 generated in the worktree is restored first (or removed, if it was never committed) and does not count as leftover work
- Option to keep worktrees for reference ("Done")

**Test Command Auto-Detection:**
Checks (in order): `package.json` `test` script (runs `npm test`), `pytest.ini`, `pyproject.toml` with a `[tool.pytest` section, `go.mod`, `Cargo.toml`. Setting `grove.testCommand` skips detection.

### 6. Dashboard

**What:** Real-time monitoring panel showing all agents, file activity, and overlaps.

**Sessions Tab:**
- Two-column grid of session cards for active and completed sessions
- Each card shows: branch, status, task, file count, start time
- Actions: Open Terminal, View Changes, Stop Session
- Sections are collapsible with expand/collapse arrows

**Activity Tab:**
- Files grouped by directory in a collapsible tree view per branch
- Each file shown once with its latest status (+/~/−) and edit count
- Noise files (`.tmp.*`, `.swp`, `.DS_Store`) automatically filtered out
- Click any file to open VS Code's diff editor (base branch vs worktree)
- Activity persists across dashboard reloads

**Overlaps Tab:**
- All detected file overlaps, sorted by severity
- Badge on tab showing active overlap count
- Each overlap: file path, branches involved, severity level
- Actions: Dismiss, Dismiss All

**Theme Compatibility:**
- Respects VS Code light/dark/high-contrast themes
- Uses VS Code CSS variables for colors
- Status colors match sidebar icon colors

**Notifications:**
- All fire-and-forget notifications truly auto-dismiss from the UI using `withProgress(ProgressLocation.Notification)`
- Info: 5 seconds, Warning: 7 seconds, Error: 10 seconds
- A countdown shows in the last 3 seconds: `Message · 3s` → `2s` → `1s` → dismissed
- Modal dialogs (confirmations) stay visible until the user responds. The merge-conflict prompt is a notification with buttons, so the editor stays usable while you resolve
- Notifications with action buttons (e.g., "Launch Claude Code", "Open Dashboard") stay visible for user interaction

---

## Built-in Team Templates

The Merge Order columns show each template's `mergeOrder`. The merge sequence does not use it yet: branches are ordered by the paths they changed (see Merge Order Recommendation under Merge Sequencer).

### Full-Stack Team
**Agents:** 4 (Backend Architect, Frontend Engineer, Test Engineer, Code Reviewer)
**Use when:** Building a complete feature that spans backend and frontend.

| Agent | Owns | Merge Order |
|-------|------|-------------|
| Backend Architect | `src/api/**`, `src/models/**`, `src/services/**`, `src/middleware/**` | 1st |
| Frontend Engineer | `src/components/**`, `src/pages/**`, `src/hooks/**`, `src/styles/**`, `src/utils/client/**` | 2nd |
| Test Engineer | `test/**`, `tests/**`, `src/**/*.test.*`, `src/**/*.spec.*`, `e2e/**` | 3rd |
| Code Reviewer | All (read-only) | — |

**Estimated tokens:** 150K–300K

### Code Review Team
**Agents:** 3 (Security Reviewer, Performance Reviewer, Architecture Reviewer)
**Use when:** You want multi-perspective review of existing code.

| Agent | Focus | Read-Only |
|-------|-------|-----------|
| Security Reviewer | Auth, injection, data exposure, OWASP top 10 | Yes |
| Performance Reviewer | N+1 queries, memory leaks, caching, complexity | Yes |
| Architecture Reviewer | Coupling, patterns, naming, maintainability | Yes |

All agents write REVIEW.md instead of modifying code. No merge needed.
**Estimated tokens:** 75K–150K

### Debug Squad
**Agents:** 3 (Debugger A — Data Flow, Debugger B — Error Patterns, Debugger C — Environment & Deps)
**Use when:** Debugging a tricky bug from multiple angles simultaneously.

| Agent | Approach |
|-------|----------|
| Debugger A — Data Flow | Traces data flow from the entry point: transformations, state mutations, API boundaries |
| Debugger B — Error Patterns | Searches for error patterns, race conditions, edge cases |
| Debugger C — Environment & Deps | Checks deps, config, env vars, platform differences |

Agents have overlapping ownership (intentional) — pick the best fix.
**Estimated tokens:** 100K–200K

### Migration Team
**Agents:** 3 (Core Migrator, Feature Migrator, Test Migrator)
**Use when:** Large framework or API migrations.

| Agent | Owns | Merge Order |
|-------|------|-------------|
| Core Migrator | `src/core/**`, `src/lib/**`, `src/utils/**` | 1st |
| Feature Migrator | `src/features/**`, `src/modules/**`, `src/pages/**`, `src/components/**` | 2nd |
| Test Migrator | `test/**`, `tests/**`, `src/**/*.test.*`, `src/**/*.spec.*` | 3rd |

The intended merge order keeps dependency chains intact.
**Estimated tokens:** 200K–400K

### Rapid Prototype
**Agents:** 3 (System Designer, Implementer, Quality Tester)
**Use when:** Fast prototyping where speed matters more than perfection.

| Agent | Owns | Merge Order |
|-------|------|-------------|
| System Designer | `docs/**`, `src/types/**`, `src/interfaces/**` | 1st |
| Implementer | `src/**` | 2nd |
| Quality Tester | `test/**`, `tests/**`, `src/**/*.test.*` | 3rd |

**Estimated tokens:** 100K–200K

### Custom Templates
Create your own templates at `.grove/templates/<name>.json`:

```json
{
  "name": "My Custom Team",
  "description": "What this team does",
  "agents": [
    {
      "role": "agent-role-id",
      "displayName": "Human-Readable Name",
      "ownership": ["src/module-a/**", "lib/shared/**"],
      "prompt": "You are responsible for... Focus on...",
      "claudeMdExtra": "Additional instructions added to this agent's instructions file",
      "readOnly": false
    }
  ],
  "mergeOrder": ["agent-role-id"],
  "estimatedTokens": "100K-200K"
}
```

Project templates override global templates (`~/.grove/templates/`), which override built-in templates.

---

## Configuration Reference

### Extension Settings (VS Code Settings)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `grove.defaultBaseBranch` | string | `"main"` | Base branch for comparisons and new worktrees |
| `grove.autoInstallDependencies` | boolean | `true` | Install dependencies after creating worktrees |
| `grove.packageManager` | enum | `"auto"` | Package manager: auto, npm, yarn, pnpm, pip, pipenv, poetry |
| `grove.worktreeLocation` | string | `".claude/worktrees"` | Directory for worktrees (relative to repo root) |
| `grove.enableAgentTeams` | boolean | `true` | On team launch, set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the global `~/.claude/settings.json` |
| `grove.templateDirectory` | string | `".grove/templates"` | Directory for team templates |
| `grove.testCommand` | string | `""` | Test command for merge steps (auto-detected if empty) |
| `grove.maxConcurrentSessions` | number | `5` | Maximum concurrent Claude Code sessions |
| `grove.showTokenEstimates` | boolean | `true` | Show token cost estimates before team launch |
| `grove.fileWatcherDebounce` | number | `500` | Debounce interval (ms) for file change events |
| `grove.notifyOnSessionComplete` | boolean | `true` | Show notification when sessions finish |
| `grove.autoGitignore` | boolean | `true` | Keep worktree folders out of `git status` by listing them in `.git/info/exclude` (never committed) |
| `grove.showStatusBarItem` | boolean | `true` | Show branch and worktree count in the status bar (click for the quick menu) |
| `grove.protectedBranches` | array | `["main", "master", "develop", "production"]` | Branches that cannot be deleted |

---

## Project-Level Configuration

Create `.grove/config.json` in your repo root for project-specific settings:

```json
{
  "projectName": "my-project",
  "conventions": {
    "framework": "Next.js + FastAPI",
    "testFramework": "vitest + pytest",
    "linter": "eslint + ruff"
  },
  "sharedFiles": [
    "package.json",
    "tsconfig.json",
    ".env.example",
    "src/types/index.ts"
  ],
  "mergeTestCommand": "npm test && npm run lint",
  "defaultTemplate": "full-stack-team"
}
```

| Field | Purpose |
|-------|---------|
| `projectName` | Not used yet |
| `conventions` | Tells agents which frameworks, test runners, and linters the project uses |
| `sharedFiles` | Files agents should document changes for (not modify directly) |
| `mergeTestCommand` | Not used yet — set the `grove.testCommand` setting instead |
| `defaultTemplate` | Not used yet |

---

## Claude Code Compatibility

Grove is designed to work alongside Claude Code, not replace it. Here's how the two interact:

**How Grove launches Claude Code:**
- Grove spawns `claude` CLI processes in VS Code integrated terminals — no API calls, no SDK, no bundled AI
- Each worktree gets its own `claude` session running in its directory
- For a team agent, Grove appends the agent's instructions file to Claude Code's system prompt: `--append-system-prompt "$(cat -- <file>)"` on macOS/Linux, `--append-system-prompt-file <file>` on Windows. The session then waits for your first message; the task is in the instructions, not sent as a prompt
- Claude Code loads the worktree's own CLAUDE.md as it normally would

**Agent Teams vs. manual parallel sessions:**
- Claude Code has a native Agent Teams feature (team lead spawns teammates with shared task lists and messaging)
- Grove implements the "manual parallel sessions with git worktrees" workflow described in Claude Code's own docs; its teams are separate `claude` sessions, one per worktree, and do not use Claude Code's Agent Teams
- Both approaches are valid — Grove adds worktree management UI, overlap detection, and a guided merge sequence on top
- Nothing stops you from using Claude Code's native Agent Teams inside a Grove-managed worktree; Grove only tracks the terminal it started, not the teammates

**Settings Grove writes:**
- `~/.claude/settings.json` (global, used by every Claude Code session) → on each team launch, when the `grove.enableAgentTeams` setting is on (the default) and the value is not already `"1"`, Grove sets `"env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }`. It rewrites the whole file as formatted JSON and does not undo the change later
- Grove does NOT modify any other Claude Code settings

**Agent instructions and CLAUDE.md:**
- Grove writes each team agent's instructions (ownership, boundaries, task) to `.grove/agents/<worktree-folder>-<hash>.md` in the main repository, outside every worktree. It never writes a CLAUDE.md into a worktree
- Relaunching Claude in an agent worktree from the sidebar reuses its instructions file; removing the worktree deletes it
- The worktree's own CLAUDE.md (checked out from its branch) is left untouched, and Claude Code loads it as usual
- The instructions include an IMPORTANT priority note so agent-specific ownership rules take precedence over project rules
- If the worktree has neither `CLAUDE.md` nor `.claude/CLAUDE.md` (for example because CLAUDE.md is untracked in the main checkout), the main checkout's CLAUDE.md is included at the bottom of the instructions as reference
- Upgrading from 0.6.0: that version wrote a generated CLAUDE.md into each agent worktree. The merge sequence and post-merge cleanup restore such a file (or remove it, if it was never committed) before they commit or remove anything, and the merge sequence warns about any branch that already committed one

**What to avoid:**
- Do not use `claude --worktree` inside a Grove-managed worktree — the `--worktree` flag creates its own worktree and auto-cleans it on exit, conflicting with Grove's lifecycle management
- If you use custom `WorktreeCreate`/`WorktreeRemove` hooks in Claude Code for non-Git VCS, Grove bypasses them (it uses native git commands)

---

## Tips for Efficient Usage

### Do

- **Start with a solo worktree** before jumping to teams. Get comfortable with the create → launch → merge flow first.
- **Write detailed task descriptions** when launching teams. The task description goes into every agent's instructions file — the more context, the better the output. For individual sessions, you can set a task description later via right-click → "Set Task Description".
- **Check the Overlaps tab** periodically during team runs. Early detection saves hours of merge conflict resolution.
- **Use the merge report** before executing merges. It lists each branch's changes, files changed in more than one worktree, and files changed on both the target branch and each worktree branch.
- **Use Code Review Team** for important PRs. Three perspectives (security, performance, architecture) catch things humans miss.
- **Set up `.grove/config.json`** for your project. Convention info helps agents write code that matches your project's patterns.
- **Use the workflow hints** in the sidebar. They guide you to the logical next step.

### Don't

- **Don't run more than 5 concurrent sessions** unless you have the compute budget. Each Claude Code session consumes tokens continuously.
- **Don't ignore overlap warnings.** An overlap on `src/api/auth.ts` between backend and frontend agents can make the second merge stop with a conflict in that file for you to resolve by hand.
- **Don't skip the merge report.** Blindly merging 4 branches into main without reviewing what changed is asking for trouble.
- **Don't manually edit files in worktree directories** while an agent is running there. The agent won't know about your changes and may overwrite them.
- **Don't use teams for trivial tasks.** A single worktree with one agent is faster and cheaper for small changes. Teams are for features that genuinely benefit from parallel work.
- **Don't delete worktrees with running sessions.** Stop the session first, then delete.
- **Don't use `claude --worktree` inside a Grove-managed worktree.** The `--worktree` flag creates its own worktree and auto-cleans it on exit, which conflicts with Grove's worktree lifecycle. Launch Claude sessions through Grove's sidebar (rocket icon) or by running `claude` (without the `--worktree` flag) inside the worktree directory. A session you start by hand does not get a team agent's instructions.

---

## Troubleshooting

### "command 'grove.createWorktree' not found"
This means the extension failed to activate. Common causes:
- **No folder open** — open a project folder (File → Open Folder)
- **Not a git repository** — run `git init` or open a folder with a `.git` directory
- **Git not installed** — install git and reload the window (⇧⌘P → Reload Window)

Since v0.3.0, all commands show a helpful error message instead of this cryptic VS Code error.

### "Claude Code CLI not found"
Grove checks for `claude` in your PATH before launching sessions. If not found, it shows a dialog with:
- **Install Instructions** — opens the Claude Code docs
- **Retry** — re-checks after you install

If `claude` is installed via a custom PATH setup (e.g., nvm, conda), make sure it's available in the shell VS Code uses.

### "No team templates found"
The extension looks for templates in three locations (in order):
1. Project: `.grove/templates/` in your repo
2. Global: `~/.grove/templates/`
3. Built-in: shipped with the extension

If none are found, the extension's `templates/` directory may not be in the VSIX. Rebuild with `npm run package`.

### Sidebar keeps refreshing / flickering
File watchers fire on every git operation. The extension debounces to 2000ms, but if you're running many parallel git commands, brief flicker may occur. This is cosmetic and does not affect functionality.

### "Worktree directory missing" (red error icon)
The worktree's directory was deleted outside of the extension (e.g., manual `rm -rf`). Right-click → Delete Worktree to clean up the git reference.

### "Git is locked by another process"
Another git operation is running. Wait a moment and retry. If stuck, delete the lock file:
```bash
rm -f .git/index.lock
```

### "Permission denied"
Check file permissions for the repository directory. On macOS/Linux: `ls -la .git/` to verify.

### Merge conflicts during merge execution
The sequencer pauses, opens up to 5 of the conflicting files, and lists them all in a dialog. Resolve the conflicts in the main checkout, save, then choose "I've Resolved — Continue". If the merge commit then fails, the merge stays in progress: finish it with `git commit`, or use `git merge --abort` if you need to start over.

### Agent Teams env var not set
When a team launches and `grove.enableAgentTeams` is on (the default), the extension writes `"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"` inside the `"env"` key of the global `~/.claude/settings.json` if it is not already set. Grove's own team launch does not depend on this variable; set `grove.enableAgentTeams` to `false` to stop the write. If the write fails (e.g., file locked or not valid JSON), you'll see a warning. Manually verify the file contains `{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }`. The value must be `"1"` (not `"true"`) and must be nested inside `"env"`, not at the root level.

### Worktree creation fails with "branch already exists"
The extension auto-detects existing branches. If the branch exists locally, it uses it. If it exists only on remote, it tracks it. The error usually means git is in an unexpected state — try `git worktree prune` to clean up stale references.

### "The base branch or starting point does not exist"
The branch you selected as the base doesn't exist locally. Run `git fetch --all` to update remote refs, then retry.

### Dashboard shows 0 files changed
The dashboard's session cards only count files that agents have committed. The merge report does not commit anything, but its counts include uncommitted and untracked files; Execute Merge Sequence commits them just before merging (see Pre-Merge Auto-Commit). Make sure sessions are completed before generating the report.

### Custom WorktreeCreate/WorktreeRemove hooks are not triggered
If you use custom `WorktreeCreate` or `WorktreeRemove` hooks in Claude Code's `settings.json` (e.g., for non-Git version control like SVN, Perforce, or Mercurial), Grove bypasses these hooks. Grove uses native `git worktree add` / `git worktree remove` commands directly. This only affects users with non-Git version control setups — standard Git users are unaffected.

---

## Command Palette Reference

All commands are available via `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux):

| Command | When to Use |
|---------|-------------|
| `Grove: Create Worktree` | Create a new isolated worktree from a selected base branch |
| `Grove: Launch Agent Team` | Launch a team of agents from a template |
| `Grove: Open Dashboard` | Open the real-time monitoring panel |
| `Grove: Check File Overlaps` | Manually trigger overlap scan |
| `Grove: Generate Merge Report` | Analyze merge readiness across worktrees |
| `Grove: Execute Merge Sequence` | Run the guided merge process |
| `Grove: Cleanup Stale Worktrees` | Pick worktrees to remove in one batch (none are pre-selected) |
| `Grove: Stop All Sessions` | Close all active Claude Code terminals |
| `Grove: Select Git Repository` | Switch which git repo Grove operates on |
| `Grove: Show All Grove Commands` | Open the status bar quick menu |

**Sidebar-only commands** (available via icons and right-click menus):

| Command | Icon | Where |
|---------|------|-------|
| `Grove: Sync from Remote` | `$(cloud-download)` | Worktree inline icon (only when behind remote), right-click menu |
| `Grove: Launch Claude Code in Worktree` | `$(rocket)` | Worktree inline icon |
| `Grove: Open in Terminal` | `$(terminal)` | Worktree inline icon |
| `Grove: Delete Worktree` | — | Worktree right-click menu |
| `Grove: Open in New Window` | — | Worktree right-click menu |
| `Grove: Stop Session` | `$(debug-stop)` | Session inline icon |
| `Grove: Open Session Terminal` | `$(terminal)` | Session inline icon |
| `Grove: Set Task Description` | — | Session right-click menu |
| `Grove: Stop Team` | `$(debug-stop)` | Team inline icon |
| `Grove: Stop Agent` | `$(debug-stop)` | Agent inline icon |
| `Grove: Cleanup Team Worktrees` | `$(trash)` | Team right-click menu |

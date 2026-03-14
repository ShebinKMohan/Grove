# WorkTree Pilot — Complete Documentation

> **Version:** 0.2.0
> **Type:** VS Code / Cursor Extension
> **License:** MIT

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [What WorkTree Pilot Is](#what-worktree-pilot-is)
3. [The Bridge — How It Connects Everything](#the-bridge)
4. [Architecture Overview](#architecture-overview)
5. [Installation & Setup](#installation--setup)
6. [UI Reference — Icons, Views & Controls](#ui-reference)
7. [Complete User Flow](#complete-user-flow)
8. [Feature Reference](#feature-reference)
   - [Worktree Management](#1-worktree-management)
   - [Session Tracking](#2-session-tracking)
   - [Agent Teams](#3-agent-teams--one-click-orchestration)
   - [Overlap Detection](#4-overlap-detection--safety-layer)
   - [Merge Sequencer](#5-merge-sequencer--intelligence)
   - [Dashboard](#6-dashboard)
9. [Built-in Team Templates](#built-in-team-templates)
10. [Configuration Reference](#configuration-reference)
11. [Project-Level Configuration](#project-level-configuration)
12. [Tips for Efficient Usage](#tips-for-efficient-usage)
13. [Troubleshooting](#troubleshooting)

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
| **No safe merge path** | After parallel work, merging branches back together is manual, error-prone, and has no guidance on order or conflicts. |
| **No team coordination** | Claude Code's Agent Teams feature requires manual worktree setup, CLAUDE.md generation, and env var configuration for every single session. |

**The result:** Developers avoid parallel AI development altogether, or attempt it manually and lose hours to merge conflicts and coordination overhead.

---

## What WorkTree Pilot Is

WorkTree Pilot is the **control plane for parallel AI development**. It wraps git worktrees, Claude Code sessions, and the Agent Teams protocol into a single, IDE-native experience.

Think of it as **"Docker Desktop for AI coding agents"** — you don't replace Claude Code, you wrap it with visibility, safety, and one-click orchestration.

**What it does:**
- Creates isolated git worktrees so multiple Claude Code sessions run in parallel without interfering
- Launches and tracks Claude Code sessions across all worktrees from one sidebar
- Provides one-click Agent Team deployment using pre-built templates
- Detects file conflicts across worktrees in real-time before they become merge nightmares
- Guides the merge process with intelligent sequencing, auto-commit, and conflict detection

**What it does NOT do:**
- It does not replace Claude Code — it orchestrates it
- It does not make API calls to Anthropic — it only spawns `claude` CLI processes in terminals
- It does not bundle any AI model — all AI work happens through your existing Claude Code installation

---

## The Bridge

WorkTree Pilot bridges three things that currently exist in isolation:

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
                     │    WorkTree Pilot        │
                     │                         │
                     │  • Creates worktrees    │
                     │  • Spawns sessions      │
                     │  • Watches for overlaps │
                     │  • Sequences merges     │
                     │  • Shows it all in one  │
                     │    unified sidebar      │
                     └─────────────────────────┘
```

**Without WorkTree Pilot:**
```
Terminal 1:  git worktree add .claude/worktrees/backend -b feat-backend
Terminal 2:  git worktree add .claude/worktrees/frontend -b feat-frontend
Terminal 3:  cd .claude/worktrees/backend && claude
Terminal 4:  cd .claude/worktrees/frontend && claude
Terminal 5:  # Manually check if they edited the same files
Terminal 6:  git merge feat-backend && git merge feat-frontend  # hope for the best
```

**With WorkTree Pilot:**
```
Sidebar:  Click "+" → name it → worktree created
Sidebar:  Click rocket icon → Claude launches in it
Dashboard: See all sessions, files changed, overlaps
Sidebar:  Click "Generate Merge Report" → see what merges cleanly
Sidebar:  Click "Execute Merge" → sequential safe merge
```

---

## Architecture Overview

```
worktree-pilot/
├── src/
│   ├── extension.ts                         # Entry point — registers commands, views, lifecycle
│   ├── core/
│   │   ├── worktree-manager.ts              # Git worktree CRUD + health checks
│   │   ├── session-tracker.ts               # Terminal session lifecycle + persistence
│   │   ├── agent-orchestrator.ts            # One-click team launch + agent lifecycle
│   │   ├── overlap-detector.ts              # Real-time cross-worktree conflict detection
│   │   ├── merge-sequencer.ts               # Merge analysis, ordering, execution
│   │   ├── template-manager.ts              # Team template loading + validation
│   │   ├── claude-md-generator.ts           # Per-agent CLAUDE.md file generation
│   │   └── config-manager.ts                # Project-level config read/write
│   ├── ui/
│   │   ├── sidebar/
│   │   │   └── unified-tree-provider.ts     # Single hierarchical sidebar TreeView
│   │   └── webview/
│   │       └── dashboard-panel.ts           # React dashboard WebView manager
│   └── utils/
│       ├── git.ts                           # Git command wrapper with write mutex
│       ├── terminal.ts                      # Terminal creation + Claude launcher
│       └── package-manager.ts               # Auto-detect npm/yarn/pnpm/pip/poetry
├── webview-ui/                              # React app for dashboard (built with Vite)
├── templates/                               # 5 built-in team templates (JSON)
└── package.json                             # Extension manifest
```

**Key design decisions:**
- Core modules have no VS Code dependency — they work with plain git and filesystem
- Git write operations are serialized through a mutex to prevent lock conflicts
- File watchers are debounced (500ms default) to handle rapid AI agent writes
- State persists to `.worktreepilot/sessions.json` across VS Code restarts
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
code --install-extension worktree-pilot-0.2.0.vsix --force
```

### First Launch
1. Open any git repository in VS Code / Cursor
2. The WorkTree Pilot icon appears in the Activity Bar (left sidebar)
3. Click it to open the sidebar — you'll see the welcome screen with quick-start buttons
4. The status bar (bottom) shows a `$(layers) WorkTree Pilot` quick menu

No additional configuration is needed. The extension auto-detects your git setup, package manager, and test commands.

---

## UI Reference

### Activity Bar Icon

| Icon | Location | Purpose |
|------|----------|---------|
| Layers icon (custom SVG) | Activity Bar (left edge) | Opens the WorkTree Pilot sidebar |

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
| `$(play-circle)` | Green | Running Session | Active Claude Code session |
| `$(watch)` | Yellow | Idle Session | Session waiting for input |
| `$(check)` | Blue | Completed Session | Finished Claude Code session |
| `$(close-dirty)` | Red | Error Session | Session that ended with errors |
| `$(archive)` | Grey | Recent Separator | Collapsible section for completed sessions |

**Agent icons** (inside teams):

| Icon | Color | Status |
|------|-------|--------|
| `$(circle-outline)` | Grey | Pending — not yet launched |
| `$(loading~spin)` | Yellow | Launching — worktree being created |
| `$(sync~spin)` | Green | Running — Claude is active |
| `$(pass)` | Blue | Completed — agent finished |
| `$(error)` | Red | Error — agent failed |
| `$(debug-stop)` | Grey | Stopped — manually stopped |

### Sidebar Context Menus (Right-Click)

**On a worktree:**
- `$(rocket)` Launch Claude Code — start a Claude session
- `$(terminal)` Open in Terminal — open a plain terminal
- `$(multiple-windows)` Open in New Window — open in separate VS Code window
- `$(diff)` View Diff — show changes vs base branch
- `$(trash)` Delete Worktree — remove worktree and branch

**On an active session:**
- `$(terminal)` Open Session Terminal — bring terminal to focus
- `$(debug-stop)` Stop Session — close the terminal

**On an active team:**
- `$(debug-stop)` Stop Team — stop all agents
- `$(trash)` Cleanup Team Worktrees — remove all worktrees

**On a completed team:**
- `$(trash)` Cleanup Team Worktrees — remove all worktrees

**On an active agent:**
- `$(terminal)` Open Agent Terminal — bring agent's terminal to focus
- `$(debug-stop)` Stop Agent — close the agent's terminal

**On the "Recent" separator:**
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
| `$(layers)` WorkTree Pilot | Bottom status bar | Opens Quick Menu with all commands |

### Dashboard Tabs

The dashboard opens as a WebView tab with three sections:

| Tab | Badge | Content |
|-----|-------|---------|
| Sessions | — | Active and completed agent cards with elapsed time, file counts, actions |
| Activity | — | Real-time feed of file changes across all worktrees |
| Overlaps | Count | List of files modified in multiple worktrees, sorted by severity |

### Dashboard Session Cards

Each card shows:
- Agent/branch name with status indicator (colored left border)
- Task description (if set)
- Files modified count (badge)
- Elapsed time (live-updating for active sessions)
- Action buttons: Open Terminal, View Changes, Stop Session

---

## Complete User Flow

This is the recommended end-to-end workflow, from setup to merged code.

### Flow 1: Solo Worktree (Single Agent)

Best for: focused single-task work where you want isolation from main.

```
Step 1 ─ Create Worktree
  Sidebar: Click "+" (top bar)
  → Enter name (e.g., "add-auth")
  → Worktree created at .claude/worktrees/add-auth/
  → Dependencies auto-installed
  → Branch: worktree-add-auth

Step 2 ─ Launch Claude Code
  Sidebar: Click rocket icon on the worktree
  → Terminal opens in the worktree directory
  → Claude Code starts with a clean session
  → Give Claude your task prompt

Step 3 ─ Monitor
  Sidebar: Workflow hint shows "1 session running — Open Dashboard"
  Dashboard: See files being modified in real-time
  Sidebar: Session appears as child of the worktree with elapsed time

Step 4 ─ Review
  Sidebar: Right-click worktree → "View Diff"
  → See all changes vs main branch

Step 5 ─ Merge
  Command Palette: "WorkTree Pilot: Generate Merge Report"
  → Review file counts, changes summary
  Command Palette: "WorkTree Pilot: Execute Merge Sequence"
  → Auto-commits uncommitted work
  → Merges into main
  → Runs tests (if configured)

Step 6 ─ Cleanup
  Sidebar: Right-click worktree → "Delete Worktree"
  → Worktree and branch removed
```

### Flow 2: Agent Team (Multi-Agent Parallel)

Best for: full features spanning backend + frontend + tests, or multi-perspective code reviews.

```
Step 1 ─ Launch Team
  Sidebar: Click team icon (top bar)
  → Select template (e.g., "Full-Stack Team")
  → Enter team name (e.g., "login-feature")
  → Enter task description (detailed prompt for all agents)
  → Pre-flight check shows overlap analysis
  → Click "Continue Anyway" (or fix ownership first)
  → Confirm launch (shows worktree count + estimated tokens)

Step 2 ─ Worktrees Created Automatically
  Extension creates:
    .claude/worktrees/login-feature-backend/
    .claude/worktrees/login-feature-frontend/
    .claude/worktrees/login-feature-tests/
    .claude/worktrees/login-feature-reviewer/
  Each gets a tailored CLAUDE.md with:
    - Role and responsibilities
    - File ownership boundaries
    - Shared files protocol
    - The task description

Step 3 ─ Sessions Launch
  4 terminals open, each running Claude Code
  → Paste or confirm the task prompt in each terminal
  → Agents work in parallel, isolated from each other
  Dashboard auto-opens showing all 4 agent cards

Step 4 ─ Monitor in Real-Time
  Dashboard → Sessions tab:
    See all 4 agents with live elapsed time and file counts
  Dashboard → Activity tab:
    See every file change across all worktrees as it happens
  Dashboard → Overlaps tab:
    Get alerted if two agents modify the same file

Step 5 ─ Handle Overlaps (if any)
  If the Overlaps tab shows conflicts:
    - Red (conflict): Two agents modified the same source file → needs manual resolution
    - Yellow (warning): Type files or barrel files modified by multiple agents → review
    - Blue (info): Config files like package.json → expected, usually auto-resolvable
  Actions: "View Diffs", "Dismiss"

Step 6 ─ Generate Merge Report
  When workflow hint says "All sessions complete — Generate Merge Report":
  Command Palette: "WorkTree Pilot: Generate Merge Report"
  → Shows per-agent stats: files changed, lines added/removed
  → Shows overlapping files with resolution guidance
  → Shows recommended merge order (types → core → API → UI → tests)

Step 7 ─ Execute Merge Sequence
  Command Palette: "WorkTree Pilot: Execute Merge Sequence"
  → Auto-commits uncommitted changes in each worktree
  → Merges agents in recommended order:
     1. Backend first (defines models and APIs)
     2. Frontend next (consumes APIs)
     3. Tests last (tests the integrated code)
  → If conflict: pauses, shows conflict details, lets you resolve
  → If tests configured: runs after each merge step

Step 8 ─ Cleanup
  Sidebar: Right-click team → "Cleanup Team Worktrees"
  → All team worktrees and branches removed
  → Or: Command Palette → "Cleanup Stale Worktrees" for batch cleanup
```

### Flow 3: Code Review Team (Read-Only)

Best for: getting multi-perspective review of existing code.

```
Step 1 ─ Launch "Code Review Team" template
  → 3 read-only agents: Security, Performance, Architecture
  → Each gets CLAUDE.md instructing them to write REVIEW.md, not modify code

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
- Single input box: enter a name (e.g., "add-auth")
- Auto-generates branch name: `worktree-add-auth`
- Creates at: `.claude/worktrees/add-auth/`
- Auto-detects package manager (npm/yarn/pnpm/pip/poetry) and installs dependencies
- Auto-adds worktree path to `.gitignore`
- Validates branch names against git rules

**Delete Worktree:**
- Safety check: warns if there are uncommitted changes or unpushed commits
- Runs `git worktree remove` and optionally `git branch -d`
- Protected branches (main, master, develop, production) cannot be deleted

**Health Checks:**
- Detects missing worktree directories
- Detects detached HEAD states
- Detects stale `.git/worktrees` lock files
- Detects worktrees with no corresponding branch

**Cleanup Wizard:**
- Finds stale worktrees: clean (no changes), no active sessions, idle
- Batch delete with confirmation dialog
- Skips protected branches

**Branch Strategy Resolution:**
- If local branch exists: uses it
- If remote branch exists but no local: tracks it
- Otherwise: creates new branch from base

### 2. Session Tracking

**What:** Tracks Claude Code terminal sessions across all worktrees.

**Session Lifecycle:**
1. **Launch** — click rocket icon or "Launch Claude Code" on a worktree
2. **Running** — terminal is active, session timer counting
3. **Idle** — terminal open but Claude waiting for input
4. **Completed** — terminal closed normally
5. **Error** — terminal closed with error state

**Session Data:**
- Branch name and worktree path
- Task description (user-settable via right-click → "Set Task Description")
- Modified files list (refreshed via `git diff --name-only`)
- Start time and elapsed duration
- Terminal instance reference

**Persistence:**
- Sessions saved to `.worktreepilot/sessions.json`
- Restored on VS Code restart (running sessions marked as completed)
- Last 5 completed sessions shown under "Recent" in sidebar

**Notifications:**
- VS Code notification when a session completes
- Action button: "View Diff" to inspect changes

**Existing Session Detection:**
- When launching Claude in a worktree that had a previous session, offers:
  - Continue existing conversation
  - Resume from checkpoint
  - Start fresh

### 3. Agent Teams — One-Click Orchestration

**What:** Deploy a coordinated team of Claude Code agents with a single click.

**Pre-Flight Checks:**
Before any worktree is created, the system:
1. Scans ownership patterns across all agents in the template
2. Detects overlapping file ownership (e.g., two agents both owning `src/api/**`)
3. Checks if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled
4. Checks concurrent session limits
5. Shows confirmation with worktree count and estimated token cost

**Per-Agent CLAUDE.md Generation:**
Each agent gets a tailored instruction file containing:

```
# WorkTree Pilot — Agent Session
Team: login-feature | Role: Backend Architect
───────────────────────────────────────

## Your Task
[User's task description]

## Your Role
[Agent's role prompt from template]

## File Ownership
You OWN these paths — only modify files matching these patterns:
  - src/api/**
  - src/models/**
  - src/services/**

Other agents own:
  - Frontend Dev: src/components/**, src/pages/**
  - Test Engineer: tests/**, src/**/*.test.*

## Shared Files Protocol
DO NOT directly modify shared files. Instead, document changes in SHARED-CHANGES.md.
  - package.json
  - tsconfig.json

## Handoff Protocol
If you need changes in files you don't own, create HANDOFF.md.

## Project Conventions
[Pulled from .worktreepilot/config.json]
```

**Team Status Sync:**
- Team status automatically updates based on agent session states
- All agents running → team "running"
- All agents done → team "completed"
- Any agent errored → team "error"

**Cleanup:**
- Right-click team → "Cleanup Team Worktrees"
- Removes all worktrees and branches created for the team

### 4. Overlap Detection — Safety Layer

**What:** Real-time detection of file conflicts across worktrees. This is the key differentiator — nobody else has this.

**How It Works:**
1. File system watchers monitor all active worktree directories
2. Each file change is recorded: `{ filePath → Set<worktreePaths> }`
3. When a file appears in more than one worktree's change set, an overlap is created
4. Overlaps are classified by severity and surfaced in the dashboard

**Severity Levels:**

| Severity | Color | When | Example |
|----------|-------|------|---------|
| **Conflict** | Red | Non-config source files modified in multiple worktrees | `src/api/auth.ts` modified by both Backend and Frontend agents |
| **Warning** | Yellow | Type definitions, barrel/index files, .d.ts files | `src/types/index.ts` modified by two agents |
| **Info** | Blue | Expected shared config files | `package.json` dependencies added by two agents |

**Shared Config Files** (classified as "info"):
`package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `tsconfig.json`, `.env`, `.gitignore`, `Makefile`, `Dockerfile`, `docker-compose.yml`, `pyproject.toml`, `requirements.txt`, `go.mod`, `go.sum`, `Cargo.toml`, `Cargo.lock`

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
- View Diffs — compare changes side by side
- Dismiss — mark as expected/resolved
- Dismiss All — clear all overlap alerts

### 5. Merge Sequencer — Intelligence

**What:** Guided merge process with analysis, ordering, and execution.

**Merge Report Generation:**
For each worktree, computes:
- Files changed count (both committed and uncommitted)
- Lines added / removed
- New files created
- Full diff stat
- REVIEW.md findings (if reviewer agent wrote one)
- HANDOFF.md notes (if agent flagged cross-team dependencies)

**Overlap Analysis:**
- Files modified in multiple worktrees identified
- Classification:
  - Auto-resolvable: config files with independent changes
  - Manual merge needed: same function modified differently

**Merge Order Recommendation:**
If the template defines `mergeOrder`, that is used. Otherwise, smart ordering based on file types:

| File Type | Priority | Rationale |
|-----------|----------|-----------|
| Types / models / interfaces | 1st (score 10) | Define contracts other code depends on |
| Core / lib / utils | 2nd (score 20) | Shared utilities used by feature code |
| API / services | 3rd (score 30) | Business logic that consumes models |
| UI / components / pages | 4th (score 40) | Frontend that consumes API |
| Tests | 5th (score 80) | Test the integrated result |
| No changes | Skip (score 100) | Nothing to merge |

**Merge Execution:**
For each worktree in order:
1. Auto-commit any uncommitted changes (stages all, commits with descriptive message)
2. Checkout base branch (main)
3. Merge the worktree's branch (`git merge <branch>`)
4. If conflict: pause, show conflicting files, let user resolve
5. If clean: optionally run tests
6. If tests pass: continue to next merge
7. If tests fail: pause, show failure, let user decide

**Post-Merge Cleanup:**
- Option to delete all worktrees after successful merge
- Option to keep worktrees for reference
- Removes generated CLAUDE.md files

**Test Command Auto-Detection:**
Checks (in order): `package.json` scripts, `pytest.ini`, `go.mod`, `Cargo.toml`

### 6. Dashboard

**What:** Real-time monitoring panel showing all agents, file activity, and overlaps.

**Sessions Tab:**
- Active session cards with live elapsed time
- Completed session cards
- Each card shows: branch, status, task, file count, elapsed time
- Actions: Open Terminal, View Changes, Stop Session
- Sections are collapsible with expand/collapse arrows

**Activity Tab:**
- Real-time feed of every file change across all active worktrees
- Each entry: timestamp, worktree name, file path, change type (created/modified/deleted)
- Helps you see exactly what each agent is doing at a glance

**Overlaps Tab:**
- All detected file overlaps, sorted by severity
- Badge on tab showing active overlap count
- Each overlap: file path, branches involved, severity level
- Actions: View Diffs, Dismiss, Dismiss All

**Theme Compatibility:**
- Respects VS Code light/dark/high-contrast themes
- Uses VS Code CSS variables for colors
- Status colors match sidebar icon colors

---

## Built-in Team Templates

### Full-Stack Team
**Agents:** 4 (Backend Architect, Frontend Developer, Test Engineer, Code Reviewer)
**Use when:** Building a complete feature that spans backend and frontend.

| Agent | Owns | Merge Order |
|-------|------|-------------|
| Backend Architect | `src/api/**`, `src/models/**`, `src/services/**` | 1st |
| Frontend Developer | `src/components/**`, `src/pages/**`, `src/hooks/**`, `src/styles/**` | 2nd |
| Test Engineer | `tests/**`, `src/**/*.test.*`, `src/**/*.spec.*` | 3rd |
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
**Agents:** 3 (Data Flow Analyst, Error Pattern Hunter, Environment Investigator)
**Use when:** Debugging a tricky bug from multiple angles simultaneously.

| Agent | Approach |
|-------|----------|
| Data Flow Analyst | Traces data flow, adds logging, validates state transitions |
| Error Pattern Hunter | Searches for error patterns, race conditions, edge cases |
| Environment Investigator | Checks deps, config, env vars, platform differences |

Agents have overlapping ownership (intentional) — pick the best fix.
**Estimated tokens:** 100K–200K

### Migration Team
**Agents:** 3 (Core Migrator, Feature Migrator, Test Migrator)
**Use when:** Large framework or API migrations.

| Agent | Owns | Merge Order |
|-------|------|-------------|
| Core Migrator | `src/core/**`, `src/lib/**`, `src/utils/**` | 1st |
| Feature Migrator | `src/features/**`, `src/pages/**`, `src/components/**` | 2nd |
| Test Migrator | `tests/**`, `src/**/*.test.*` | 3rd |

Sequential merge order preserves dependency chains.
**Estimated tokens:** 200K–400K

### Rapid Prototype
**Agents:** 3 (System Designer, Implementer, Quality Tester)
**Use when:** Fast prototyping where speed matters more than perfection.

| Agent | Owns | Merge Order |
|-------|------|-------------|
| System Designer | `src/types/**`, `src/config/**`, `docs/**` | 1st |
| Implementer | `src/**` (excluding types/config) | 2nd |
| Quality Tester | `tests/**`, `src/**/*.test.*` | 3rd |

**Estimated tokens:** 100K–200K

### Custom Templates
Create your own templates at `.worktreepilot/templates/<name>.json`:

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
      "claudeMdExtra": "Additional instructions for CLAUDE.md",
      "readOnly": false
    }
  ],
  "mergeOrder": ["agent-role-id"],
  "estimatedTokens": "100K-200K"
}
```

Project templates override global templates (`~/.worktreepilot/templates/`), which override built-in templates.

---

## Configuration Reference

### Extension Settings (VS Code Settings)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `worktreePilot.defaultBaseBranch` | string | `"main"` | Base branch for comparisons and new worktrees |
| `worktreePilot.autoInstallDependencies` | boolean | `true` | Install dependencies after creating worktrees |
| `worktreePilot.packageManager` | enum | `"auto"` | Package manager: auto, npm, yarn, pnpm, pip, poetry |
| `worktreePilot.worktreeLocation` | string | `".claude/worktrees"` | Directory for worktrees (relative to repo root) |
| `worktreePilot.enableAgentTeams` | boolean | `true` | Enable Agent Teams features |
| `worktreePilot.templateDirectory` | string | `".worktreepilot/templates"` | Directory for team templates |
| `worktreePilot.testCommand` | string | `""` | Test command for merge steps (auto-detected if empty) |
| `worktreePilot.maxConcurrentSessions` | number | `5` | Maximum concurrent Claude Code sessions |
| `worktreePilot.showTokenEstimates` | boolean | `true` | Show token cost estimates before team launch |
| `worktreePilot.fileWatcherDebounce` | number | `500` | Debounce interval (ms) for file change events |
| `worktreePilot.notifyOnSessionComplete` | boolean | `true` | Show notification when sessions finish |
| `worktreePilot.autoGitignore` | boolean | `true` | Auto-add worktree paths to .gitignore |
| `worktreePilot.showStatusBarItem` | boolean | `true` | Show quick menu in status bar |
| `worktreePilot.protectedBranches` | array | `["main", "master", "develop", "production"]` | Branches that cannot be deleted |

---

## Project-Level Configuration

Create `.worktreepilot/config.json` in your repo root for project-specific settings:

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
| `projectName` | Included in generated CLAUDE.md files for agent context |
| `conventions` | Tells agents which frameworks, test runners, and linters the project uses |
| `sharedFiles` | Files agents should document changes for (not modify directly) |
| `mergeTestCommand` | Command to run after each merge step |
| `defaultTemplate` | Pre-selected template when launching teams |

---

## Tips for Efficient Usage

### Do

- **Start with a solo worktree** before jumping to teams. Get comfortable with the create → launch → merge flow first.
- **Write detailed task descriptions** when launching teams. The task description goes into every agent's CLAUDE.md — the more context, the better the output.
- **Check the Overlaps tab** periodically during team runs. Early detection saves hours of merge conflict resolution.
- **Use the merge report** before executing merges. It tells you exactly what will happen and highlights potential conflicts.
- **Use Code Review Team** for important PRs. Three perspectives (security, performance, architecture) catch things humans miss.
- **Set up `.worktreepilot/config.json`** for your project. Convention info helps agents write code that matches your project's patterns.
- **Use the workflow hints** in the sidebar. They guide you to the logical next step.

### Don't

- **Don't run more than 5 concurrent sessions** unless you have the compute budget. Each Claude Code session consumes tokens continuously.
- **Don't ignore overlap warnings.** A conflict in `src/api/auth.ts` between backend and frontend agents means one will overwrite the other during merge.
- **Don't skip the merge report.** Blindly merging 4 branches into main without reviewing what changed is asking for trouble.
- **Don't manually edit files in worktree directories** while an agent is running there. The agent won't know about your changes and may overwrite them.
- **Don't use teams for trivial tasks.** A single worktree with one agent is faster and cheaper for small changes. Teams are for features that genuinely benefit from parallel work.
- **Don't delete worktrees with running sessions.** Stop the session first, then delete.

---

## Troubleshooting

### "No team templates found"
The extension looks for templates in three locations (in order):
1. Project: `.worktreepilot/templates/` in your repo
2. Global: `~/.worktreepilot/templates/`
3. Built-in: shipped with the extension

If none are found, the extension's `templates/` directory may not be in the VSIX. Rebuild with `npm run package`.

### Sidebar keeps refreshing / flickering
File watchers fire on every git operation. The extension debounces to 2000ms, but if you're running many parallel git commands, brief flicker may occur. This is cosmetic and does not affect functionality.

### "Worktree directory missing" (red error icon)
The worktree's directory was deleted outside of the extension (e.g., manual `rm -rf`). Right-click → Delete Worktree to clean up the git reference.

### Merge conflicts during merge execution
The sequencer pauses and shows which files conflict. Resolve conflicts in the main directory, then re-run the merge step. Use `git merge --abort` if you need to start over.

### Claude Code session exits immediately
Check that the `claude` CLI is installed and available in your PATH. Run `which claude` in a terminal to verify. The extension launches Claude through a clean zsh shell — if claude is installed via a custom PATH setup, it may not be found.

### Agent Teams env var not set
The extension auto-writes `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: true` to `~/.claude/settings.json`. If teams still don't work, check that file exists and contains the setting.

### Worktree creation fails with "branch already exists"
The extension auto-detects existing branches. If the branch exists locally, it uses it. If it exists only on remote, it tracks it. The error usually means git is in an unexpected state — try `git worktree prune` to clean up stale references.

### Dashboard shows 0 files changed
Files are only counted after agents commit their work. If agents are still running (code is uncommitted), the merge report auto-commits before analysis. Make sure sessions are completed before generating the report.

---

## Command Palette Reference

All commands are available via `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux):

| Command | When to Use |
|---------|-------------|
| `WorkTree Pilot: Create Worktree` | Create a new isolated worktree |
| `WorkTree Pilot: Launch Agent Team` | Deploy a coordinated team of agents |
| `WorkTree Pilot: Open Dashboard` | Open the real-time monitoring panel |
| `WorkTree Pilot: Check File Overlaps` | Manually trigger overlap scan |
| `WorkTree Pilot: Generate Merge Report` | Analyze merge readiness across worktrees |
| `WorkTree Pilot: Execute Merge Sequence` | Run the guided merge process |
| `WorkTree Pilot: Cleanup Stale Worktrees` | Find and remove idle worktrees |
| `WorkTree Pilot: Stop All Sessions` | Close all active Claude Code terminals |
| `WorkTree Pilot: Quick Menu` | Open the status bar quick menu |

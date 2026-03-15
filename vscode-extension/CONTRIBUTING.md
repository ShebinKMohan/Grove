# Contributing to Grove

Thanks for your interest in contributing! Here's how to get started.

## Dev Setup

```bash
# Clone the repo
git clone https://github.com/ShebinKMohan/Grove.git
cd Grove/vscode-extension

# Install dependencies (also installs webview-ui deps via postinstall)
npm install

# Compile everything (webview + extension)
npm run compile

# Run tests
npm test

# Package the VSIX locally
npm run package
```

## Running in Development

1. Open `vscode-extension/` in VS Code
2. Press `F5` to launch the Extension Development Host
3. The extension activates in any folder with a `.git` directory

## Project Structure

```
vscode-extension/
  src/
    extension.ts              # Entry point — all command registrations
    core/                     # Business logic (worktree, session, team, merge)
    ui/sidebar/               # TreeView providers
    ui/webview/               # Dashboard WebView panel
    utils/                    # Git, terminal, package manager helpers
  webview-ui/                 # React + Vite dashboard app
  templates/                  # Built-in team templates (JSON)
  test/suite/                 # Vitest unit tests
```

## Before Submitting a PR

- Run `npx tsc --noEmit` — must be clean (zero errors)
- Run `npm test` — all 109+ tests must pass
- Run `npm run package` — VSIX must build successfully
- Keep changes focused — one feature or fix per PR

## What to Contribute

- **Bug fixes** — check [open issues](https://github.com/ShebinKMohan/Grove/issues)
- **New team templates** — add a JSON file to `templates/`
- **Dashboard improvements** — the React app is in `webview-ui/src/`
- **Test coverage** — especially for core modules that currently test reimplemented logic
- **Documentation** — improvements to DOCUMENTATION.md or inline comments

## Reporting Issues

Use [GitHub Issues](https://github.com/ShebinKMohan/Grove/issues). Include:
- VS Code / Cursor version
- Grove version (`grove-pilot` in Extensions panel)
- Steps to reproduce
- Error messages (check Output panel > "Grove")

## Code Style

- TypeScript strict mode, no `any` types
- Use existing patterns — check how similar code is structured before adding new abstractions
- All notifications use `showAutoInfo` / `showAutoWarning` / `showAutoError` (auto-dismiss)
- Git operations go through `git()` / `gitWrite()` helpers in `utils/git.ts`

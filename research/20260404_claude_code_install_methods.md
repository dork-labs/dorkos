---
title: 'Claude Code CLI: Official Installation Methods (April 2026)'
date: 2026-04-04
type: external-best-practices
status: active
tags: [claude-code, installation, cli, npm, native-installer]
searches_performed: 2
sources_count: 1
---

## Research Summary

As of April 2026, `npm install -g @anthropic-ai/claude-code` is **deprecated**. Anthropic now recommends a native binary installer delivered via shell script. npm install still works for compatibility but is explicitly flagged as legacy in the official docs.

## Key Findings

1. **Recommended install is a curl/shell script, not npm.** Native installer auto-updates in the background; npm does not.
2. **Three supported install methods**: native script (recommended), Homebrew (macOS), WinGet (Windows).
3. **npm is deprecated but functional.** Docs explicitly say "Use the native installation method when possible" and provide a migration path away from npm.
4. **No pnpm, yarn, or bun support mentioned.** Only npm is listed as an alternative to the native installer.
5. **Desktop app available** as a fully GUI option (macOS dmg, Windows installer) — no terminal needed.

## Install Commands by Method

### Native Installer (Recommended)

Auto-updates in the background. No Node.js dependency required.

| Platform            | Command                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| macOS / Linux / WSL | `curl -fsSL https://claude.ai/install.sh \| bash`                                           |
| Windows PowerShell  | `irm https://claude.ai/install.ps1 \| iex`                                                  |
| Windows CMD         | `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd` |

Windows requires [Git for Windows](https://git-scm.com/downloads/win) as a prerequisite.

### Homebrew (macOS)

```bash
brew install --cask claude-code
```

Does NOT auto-update. Requires manual `brew upgrade claude-code`.

### WinGet (Windows)

```powershell
winget install Anthropic.ClaudeCode
```

Does NOT auto-update. Requires manual `winget upgrade Anthropic.ClaudeCode`.

### npm (Deprecated)

```bash
npm install -g @anthropic-ai/claude-code
```

Requires Node.js 18+. Do NOT use `sudo npm install -g`. Explicitly marked deprecated in official docs — no mention of pnpm, yarn, or bun as alternatives.

## Platform-Specific Notes

- **Alpine Linux / musl**: requires `apk add libgcc libstdc++ ripgrep` + setting `USE_BUILTIN_RIPGREP=0` in settings.json
- **Windows WSL**: both WSL 1 and WSL 2 supported; WSL 2 adds sandboxing support
- **Windows native**: uses Git Bash internally even when launched from PowerShell or CMD

## Migration from npm to Native

```bash
# Install native binary
curl -fsSL https://claude.ai/install.sh | bash

# Remove old npm installation
npm uninstall -g @anthropic-ai/claude-code
```

## Versioning Options

The native installer accepts a channel or pinned version:

```bash
# Latest (default)
curl -fsSL https://claude.ai/install.sh | bash

# Stable channel (~1 week old, fewer regressions)
curl -fsSL https://claude.ai/install.sh | bash -s stable

# Specific version
curl -fsSL https://claude.ai/install.sh | bash -s 2.1.89
```

## Sources & Evidence

- Official docs: [Advanced setup — Claude Code](https://code.claude.com/docs/en/getting-started) (redirects from docs.anthropic.com/en/docs/claude-code/getting-started), fetched 2026-04-04
- Direct quote on npm: "npm installation is deprecated. The native installer is faster, requires no dependencies, and auto-updates in the background."

## Research Gaps

- pnpm/yarn/bun install paths: not mentioned anywhere in official docs; likely unsupported for global install
- Whether `@anthropic-ai/claude-code` on npm will eventually be unpublished or just unmaintained

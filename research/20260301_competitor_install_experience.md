---
title: "Competitor Install Experience Analysis & DorkOS Install Strategy"
date: 2026-03-01
type: external-best-practices
status: active
tags: [installation, cli, onboarding, install-script, curl, npm, homebrew, claude-code, opencode, openclaw, codex, competitor-analysis]
feature_slug: installation-experience
searches_performed: 14
sources_count: 22
---

# Competitor Install Experience Analysis & DorkOS Install Strategy

**Research Date:** 2026-03-01
**Research Mode:** Deep Research
**Objective:** Analyze competitor install experiences (Claude Code, OpenClaw, OpenCode, Codex) and formulate a best-in-class install strategy for DorkOS.

---

## Research Summary

The developer tool install landscape has undergone a significant shift in 2025–2026: the native binary + `curl | bash` pattern has decisively displaced `npm install -g` as the preferred approach for developer CLI tools, with Claude Code itself having deprecated its own npm path. DorkOS's current `npm install -g dorkos` install is now the outlier in its competitive set, and this matters: install method directly shapes the first impression of a developer tool. The research identifies specific patterns used by each competitor, analyzes their install scripts, and culminates in a concrete recommendation matrix for DorkOS.

---

## Key Findings

### 1. The Industry Has Moved Past `npm install -g`

Claude Code deprecated npm installation and now marks it as a legacy method. Their native `curl -fsSL https://claude.ai/install.sh | bash` pattern offers auto-updates, faster installation (no Node.js runtime overhead), and binary integrity verification. This is not a fringe pattern — rustup, Bun, Deno, and now Claude Code all use it. For DorkOS, which installs via `npm install -g dorkos`, this is the most important strategic gap to close.

### 2. Tabbed Install UIs Are the Standard

All competitors (OpenCode, Claude Code) use tabbed interfaces on their documentation/download pages to organize multiple install methods without overwhelming the user. The default tab is always the recommended method. Users who want alternatives find them one click away. No competitor shows all methods simultaneously.

### 3. Every Competitor Offers at Least 3 Install Methods

| Tool | Methods |
|------|---------|
| Claude Code | curl/bash (recommended), Homebrew, WinGet, Desktop app, npm (deprecated) |
| OpenCode | curl/bash, npm, bun, Homebrew, AUR, Go |
| OpenClaw | curl/bash, npm, git clone |
| Codex | npm, Homebrew, binary download, web app |

DorkOS currently offers 1 method: `npm install -g dorkos`.

### 4. Install Scripts All Do OS + Arch Detection

Every curl-based installer detects `uname -s` (OS) and `uname -m` (architecture) to download the correct binary. Claude Code additionally checks for Rosetta 2 emulation on macOS. This eliminates manual platform selection from the user experience.

### 5. Claude Code's Script Is the Gold Standard for Security

Claude Code's bootstrap.sh is the only script in this competitive set that:
- Downloads a manifest.json with platform-specific SHA256 checksums
- Verifies the downloaded binary against the checksum before executing
- Signs binaries (notarized by Apple on macOS, signed by "Anthropic, PBC" on Windows)
- Auto-updates in the background on subsequent runs

OpenCode's install script has no checksum verification. OpenClaw's script verifies only its `gum` UI dependency, not its own package.

### 6. DorkOS Cannot Use `curl | bash` in Its Current Architecture

DorkOS is a Node.js application (Express server + React SPA + Claude Agent SDK). It cannot be distributed as a self-contained binary without a build step that embeds a Node.js runtime (e.g., using `pkg`, `nexe`, or Bun's compile feature). However, the research shows that wrapping npm install inside a curl script — to enable OS detection, dependency checks, and a better UX narrative — is a valid intermediate approach used by several tools including OpenClaw.

---

## Competitor Analysis: Detailed Breakdown

### Claude Code

**Install methods (in order of recommendation):**
1. `curl -fsSL https://claude.ai/install.sh | bash` (macOS/Linux/WSL) — "Native Install (Recommended)"
2. `irm https://claude.ai/install.ps1 | iex` (Windows PowerShell)
3. `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd` (Windows CMD)
4. `brew install --cask claude-code` (Homebrew — manual updates)
5. `winget install Anthropic.ClaudeCode` (Windows)
6. `npm install -g @anthropic-ai/claude-code` (deprecated)
7. Desktop app for macOS and Windows (dmg/exe download)

**Website install UX:**
- Tabbed interface, "Native Install" pre-selected
- Each tab has a copy-ready code block
- Info box in each tab explains the update behavior difference
- Tip at top: "Prefer a graphical interface? The Desktop app..."
- Link to Desktop quickstart for non-terminal users

**Install script behavior (bootstrap.sh at https://claude.ai/install.sh):**
- Checks for `curl` or `wget`; exits with clear message if neither found
- OS detection via `uname -s`: Darwin → macOS, Linux → Linux; Windows exits with error directing to install.cmd
- Arch detection via `uname -m`: supports x64 and arm64
- Rosetta 2 detection: `sysctl -n sysctl.proc_translated` — if emulated, downloads arm64 even on x64 Mac
- Linux variant: distinguishes glibc vs musl C library
- Downloads manifest.json with SHA256 checksums from GCS bucket
- Downloads platform-specific binary
- Verifies SHA256 checksum; deletes binary and exits 1 if verification fails
- Saves to `~/.claude/downloads`, makes executable, runs with `install` subcommand
- Auto-update: built into the binary itself, runs on startup and periodically in background

**Post-install UX:**
- 3-step quickstart: Install → Log in (`claude` prompts browser auth) → Start (`cd myproject && claude`)
- `claude doctor` command for installation diagnostics
- Version pinning support: `curl ... | bash -s 1.0.58`

**Strengths:** Best security posture of any competitor (checksums + code signing), auto-updates, clear OS-specific tabs, progressive quickstart. Desktop app as escape hatch for non-terminal users.

**Weaknesses:** Windows experience requires Git for Windows prerequisite. Complex multi-tab documentation. npm deprecation creates confusion for users with old bookmarks.

---

### OpenCode

**Install methods:**
1. `curl -fsSL https://opencode.ai/install | bash` (primary)
2. `npm i -g opencode-ai`
3. `bun add -g opencode-ai`
4. `brew install anomalyco/tap/opencode`
5. `paru -S opencode` (Arch Linux AUR)
6. `go install github.com/opencode-ai/opencode@latest`
7. Desktop app (macOS Apple Silicon, macOS Intel, Windows x64, Linux .deb, .rpm)
8. VS Code, Cursor, Zed, Windsurf extensions
9. GitHub and GitLab integrations

**Website install UX:**
- Download page at opencode.ai/download
- 4 numbered sections: Terminal, Desktop, Extensions, Integrations
- Terminal section shows all 5 methods simultaneously (curl, npm, bun, brew, paru)
- Desktop section has per-platform download buttons
- No OS detection (shows all options)
- Home page shows `curl -fsSL https://opencode.ai/install | bash` as the hero install command

**Install script behavior:**
- `set -euo pipefail` for strict error handling
- OS detection: Darwin → darwin, Linux → linux, MINGW/MSYS/CYGWIN → windows
- Arch detection: normalizes aarch64 → arm64, x86_64 → x64; checks Rosetta 2
- CPU feature detection: checks AVX2 support across all platforms; appends "-baseline" to filename if no AVX2
- Validates supported platform combinations
- Installs to `~/.opencode/bin` (created if missing)
- Downloads .tar.gz (Linux) or .zip (macOS/Windows) from GitHub releases
- PATH management: detects shell (bash/zsh/fish/ash/sh), appends to first writable config file; falls back to manual instructions; handles GitHub Actions
- **No checksum verification** — just HTTP status code validation
- `--help`, `--version`, `--binary` (local binary path), `--dry-run`, `--verbose` flags

**Post-install UX:**
- Not well documented on the install page; defers to docs site

**Strengths:** Comprehensive method coverage, Go install option is unique (targets existing Go users). Desktop app and IDE extensions provide non-terminal entry points.

**Weaknesses:** No checksum verification in install script. Download page shows too many options simultaneously (cognitive overload). AVX2 detection is novel but adds complexity. The Arch Linux paru option is niche.

---

### OpenClaw

**Install methods:**
1. `curl -fsSL https://openclaw.ai/install.sh | bash` (primary)
2. `npm i -g openclaw && openclaw onboard`
3. `curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git` (hackable method)

**Website install UX:**
- Home page has a "Quick Start" section showing the 3 methods
- Clean, minimal presentation — matches the overall site aesthetic
- The `openclaw onboard` step after npm is notable: install and onboard are separate but chained

**Install script behavior (most complex of the competitors):**
- OS detection: Darwin (macOS), Linux (including WSL detection via `WSL_DISTRO_NAME`)
- Arch detection: x86_64, arm64, i386, armv7, armv6
- Downloads `gum` (Charmbracelet TUI library) for an interactive spinner UI during install — verified with `sha256sum/shasum` against checksums.txt
- Dependency validation: curl/wget, tar, node 22+, npm, git, pnpm/corepack, make/cmake/python3 (for native builds)
- npm installation with automatic build-tools installation on failure
- NPM conflict resolution (stale directories, existing binaries)
- Fallback to non-spinner mode if gum fails
- PATH management: npm global bin dir + `~/.local/bin` for git method
- `--dry-run`, `--verbose`, `NO_PROMPT=1` flags
- Legacy env var compatibility (CLAWDBOT_* → OPENCLAW_*)
- Holiday taglines appended based on current date (genuinely charming)
- Runs `openclaw onboard` interactive setup at end (skippable with `--no-onboard`)

**Post-install UX:**
- `openclaw onboard` is the primary onboarding mechanism — an interactive CLI setup wizard that configures API keys, connections, and preferences

**Strengths:** The most feature-complete install script. Interactive TUI via `gum` is genuinely impressive UX. The `onboard` step being built into the install flow is the right design pattern. Holiday taglines show personality.

**Weaknesses:** Enormous script complexity (hundreds of lines). Node 22+ requirement is strict. Windows not supported. Being open-sourced to a foundation after creator joined OpenAI creates maintenance uncertainty.

---

### Codex (OpenAI)

**Install methods:**
1. `npm install -g @openai/codex` (terminal CLI)
2. `brew install codex` (Homebrew)
3. GitHub release binary downloads
4. Web app at chatgpt.com/codex (no install required)
5. VS Code, Cursor, Windsurf IDE extensions

**Website install UX:**
- Developer docs at developers.openai.com/codex
- Quickstart shows npm and Homebrew as the two primary methods
- No curl script
- Web app is the zero-friction path (no install)

**Install script behavior:** None — Codex does not offer a curl-based installer. Relies entirely on npm and Homebrew.

**Post-install UX:**
- Run `codex` → prompted to sign in with ChatGPT account or API key
- Recommends creating Git checkpoints before and after each task

**Strengths:** Web app eliminates install barrier entirely for first-time users. ChatGPT account = automatic auth (no separate signup). Enterprise-friendly.

**Weaknesses:** No curl installer. npm-first approach is the least sophisticated of the group. The web app is cloud-only which conflicts with developer sovereignty preferences. No auto-update mechanism documented.

---

## Install Script Comparison Matrix

| Capability | Claude Code | OpenCode | OpenClaw | Codex |
|-----------|-------------|----------|----------|-------|
| curl install | Yes (recommended) | Yes (primary) | Yes (primary) | No |
| npm install | Deprecated | Yes | Yes | Yes (primary) |
| Homebrew | Yes (cask) | Yes | No | Yes |
| Desktop app | Yes | Yes (beta) | No | Web app |
| IDE extensions | Yes | Yes | No | Yes |
| OS detection | Yes | Yes | Yes | N/A |
| Arch detection | Yes | Yes + AVX2 | Yes | N/A |
| Rosetta 2 detection | Yes | Yes | No | N/A |
| Checksum verification | Yes (SHA256) | No | Yes (gum only) | N/A |
| Code signing | Yes (Apple + MSFT) | No | No | N/A |
| Auto-updates | Yes | No | No | No |
| PATH management | Via binary installer | Yes | Yes | N/A |
| Interactive onboarding | Via `claude` REPL | No | `openclaw onboard` | Via `codex` REPL |
| Windows support | Yes (native + WSL) | Yes (MINGW) | No | Yes (web + npm) |
| Version pinning | Yes | Yes (`--version`) | No | No |
| Dry-run mode | No | Yes (`--dry-run`) | Yes (`--dry-run`) | No |

---

## Install Method Comparison Matrix (Pros/Cons)

| Method | Pros | Cons | Used By |
|--------|------|------|---------|
| `curl \| bash` (native binary) | Single command, no dependencies, auto-update capable, OS/arch detection, fastest | Security concerns (curl-to-bash), requires compiled binary | Claude Code, OpenCode, OpenClaw, rustup, Bun, Deno |
| `npm install -g` | Familiar to JS devs, existing infrastructure | Requires Node.js, no auto-update, slow (npm resolution), version conflicts, no OS detection | Codex, legacy Claude Code |
| `brew install` | Trusted by macOS devs, easy to audit, managed updates | macOS/Linux only, no auto-update (need `brew upgrade`), lag before new versions appear | Claude Code, OpenCode, Codex |
| `bun add -g` | Faster than npm, modern | Requires Bun runtime, less universal | OpenCode |
| `winget` | Windows-native, trusted store | Windows only, no auto-update, version lag | Claude Code |
| Desktop app | No terminal required, broadest audience | Larger download, separate update mechanism | Claude Code, OpenCode |
| Web app | Zero install | Cloud-only, no local execution | Codex |
| IDE extension | Contextual, no terminal | IDE-specific, not standalone | Claude Code, OpenCode, Codex |

---

## Best Practices from the Broader Ecosystem

### The `curl | bash` Security Debate

The `curl | bash` pattern has legitimate security concerns (MITM, partial execution, server-side detection). However:

1. The practice is now the industry norm for developer CLIs — Claude Code, OpenCode, OpenClaw, rustup, Bun, Deno all use it
2. The risk is substantially mitigated by: HTTPS enforcement, checksum verification (as Claude Code does), and code signing
3. The alternative (npm install) has its own risks: npm supply chain attacks, post-install scripts, permission issues
4. For DorkOS's target audience (developers who use Claude Code), `curl | bash` is already in their daily workflow

**The mitigation pattern (from Claude Code):**
- Serve bootstrap.sh over HTTPS only
- Download a manifest.json with SHA256 checksums from the same server
- Verify the downloaded binary/archive against the checksum before execution
- Sign the binary (Apple notarization, Windows Authenticode)

### PATH Management

The universally adopted pattern:
1. Detect active shell (bash/zsh/fish) from `$SHELL`
2. Find the shell's RC file (`~/.zshrc`, `~/.bashrc`, `~/.config/fish/config.fish`)
3. Check if install dir is already in PATH via `":$PATH:" != *":$INSTALL_DIR:"*`
4. Append `export PATH=$INSTALL_DIR:$PATH` only if not present
5. Print instructions to `source` the RC file or open a new terminal
6. Handle `$GITHUB_PATH` for CI environments

### Version Pinning

Every mature install script accepts a version argument:
- `curl -fsSL https://tool.ai/install.sh | bash -s 1.2.3`
- `curl -fsSL https://tool.ai/install.sh | bash -s stable`

This is critical for reproducible deployments and CI/CD.

### Auto-Update Architecture

Two patterns observed:
1. **Binary self-replace** (Claude Code): The installed binary contains its own update logic. On startup, it checks a version endpoint, downloads a new binary to a temp location, verifies checksum, and replaces itself. Zero external dependencies.
2. **Script-driven** (rustup): The install script itself is idempotent; re-running it upgrades. `rustup self update` downloads a new rustup binary and replaces the current one.

For Node.js CLIs installed via npm, neither pattern is clean — the npm-installed binary cannot replace itself without npm involvement. This is a core reason Claude Code moved away from npm.

---

## DorkOS-Specific Analysis

### Current State

DorkOS installs via `npm install -g dorkos`. The CLI package (`packages/cli`) bundles:
- Vite-built React SPA → `dist/client/`
- esbuild-bundled Express server → `dist/server/index.js`
- esbuild CLI entry point → `dist/bin/cli.js`

The build pipeline produces pure JavaScript artifacts that require a Node.js runtime. This is the key constraint: DorkOS cannot be distributed as a self-contained binary without either:
1. Shipping Node.js as part of the distribution (adds ~50MB)
2. Using Bun's `bun build --compile` to produce a standalone executable
3. Wrapping the npm install in a curl script (hybrid approach)

### Architecture Options for Native Binary Distribution

**Option A: Bun compile**
Bun's `bun build --compile` produces a single executable that embeds the Bun runtime. DorkOS's server is Express (Node.js compatible); Bun's Node.js compatibility layer handles most cases. Risk: compatibility with native modules (better-sqlite3) requires Bun's C binding support.

**Option B: pkg/nexe**
`pkg` (Vercel) or `nexe` embed Node.js into the binary. Produces a standalone ~80MB executable. Mature tooling, good native module support. Used by production CLIs.

**Option C: Hybrid curl script wrapping npm**
A `curl -fsSL https://dorkos.ai/install.sh | bash` script that:
1. Checks Node.js 18+ is installed; installs via nvm if not
2. Runs `npm install -g dorkos`
3. Runs `dorkos --post-install-check` to verify the installation worked
4. Optionally runs `dorkos init` for first-time setup

This is what OpenClaw does. Provides the `curl` UX without requiring binary compilation. Simpler to implement in the short term.

---

## Recommendations for DorkOS

### Tier 1: Immediate (Unblock the npm install UX)

**1. Add a shell install script at dorkos.ai/install**

Even wrapping npm, this script provides meaningful value:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Check Node.js 18+
if ! command -v node &>/dev/null; then
  echo "Node.js is required. Install it from https://nodejs.org or run:"
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
  exit 1
fi

NODE_VERSION=$(node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
if [ "$NODE_VERSION" = "old" ]; then
  echo "Node.js 18+ is required. Current version: $(node --version)"
  exit 1
fi

npm install -g dorkos

echo ""
echo "DorkOS installed. Run: dorkos"
echo "Or run the setup wizard: dorkos init"
```

This is the minimum viable curl installer. It still requires npm but provides a proper entry point URL, dependency checking, and a clear post-install message.

**2. Add Homebrew tap**

Create `dorkos-ai/homebrew-tap` GitHub repository with a formula that wraps `npm install -g dorkos`. This gives macOS developers their preferred install path and provides discoverability in `brew search`. The formula is maintained separately from the npm package.

**3. Update the docs site install UX**

Add a tabbed install section to `dorkos.ai/docs` (and ideally the homepage) with:
- Tab 1: `curl -fsSL https://dorkos.ai/install | bash` (recommended)
- Tab 2: `npm install -g dorkos`
- Tab 3: `brew install dorkos-ai/tap/dorkos`

Pre-select Tab 1. Each tab shows only its command.

### Tier 2: Medium-Term (Proper Self-Contained Binary)

**4. Evaluate Bun compile for DorkOS**

The strategic move is producing a standalone binary via `bun build --compile`. This would:
- Enable the same bootstrap.sh pattern as Claude Code (no Node.js requirement)
- Enable background auto-updates (the binary replaces itself)
- Eliminate npm as a runtime dependency
- Enable distributing DorkOS to users who don't have Node.js

The blocker is `better-sqlite3` (native module). Bun has SQLite built-in (`bun:sqlite`), and the database package (`packages/db`) uses Drizzle ORM — migrating from `better-sqlite3` to Bun's built-in SQLite would be required. This is a meaningful but bounded migration.

**5. Add auto-update capability**

Once on a binary distribution model, implement Claude Code's pattern:
- On startup: async check of a version endpoint (no blocking)
- If newer version: download to temp, verify SHA256, replace binary on next exit
- `dorkos update` command for explicit manual update
- `DORKOS_DISABLE_AUTOUPDATER=1` env var to opt out

This is the most impactful UX improvement: eliminating the "re-run npm install to update" friction.

### Tier 3: Ecosystem Expansion

**6. WinGet package**

Submit to the Microsoft WinGet Community Repository: `winget install DorkOS.DorkOS`. Required for enterprise Windows users. Follows the same pattern as `winget install Anthropic.ClaudeCode`.

**7. Desktop app consideration**

Claude Code and OpenCode both offer desktop apps for non-terminal users. For DorkOS, this is particularly interesting because DorkOS is already a web app served by a local server. A desktop wrapper (Electron or Tauri) would:
- Eliminate the "open browser at localhost" step
- Provide system tray integration
- Enable macOS/Windows installation without a terminal

This aligns with DorkOS's strategic position: it already has a React SPA, it just needs a native shell.

---

## Install Script Design Principles (for DorkOS)

When building the DorkOS install script, apply these principles from the research:

1. **Fail loudly, fail early.** Check all dependencies before doing anything. Clear error messages with actionable instructions.

2. **Never require sudo.** Install to `~/.local/bin` or similar user-owned directory. Avoid `/usr/local/bin` unless explicitly requested.

3. **Verify before execute.** Even if not using a full binary distribution yet, any downloaded artifact should be checksummed.

4. **PATH management is the most error-prone step.** Test on bash, zsh, and fish. Handle `$GITHUB_PATH` for CI. Print explicit instructions to reload the shell.

5. **Print a clean completion message.** After successful install:
   ```
   DorkOS v1.x.x installed.

   Run: dorkos
   Or:  dorkos init   (first-time setup wizard)

   Documentation: https://dorkos.ai/docs
   ```

6. **Support version pinning from day one.** `curl ... | bash -s 1.2.3`. This is free to implement and invaluable for CI reproducibility.

7. **Non-interactive mode.** `DORKOS_NO_PROMPT=1 curl ... | bash` for CI environments. Skip all confirmations.

8. **Dry-run mode.** `curl ... | bash -s -- --dry-run` shows what would happen without doing it. Good for auditing.

---

## Detailed Analysis

### Why `npm install -g` Is an Install Experience Problem

The core issue is not technical but perceptual. When a developer sees `npm install -g dorkos`, they immediately form expectations:

1. "I need Node.js" — a prerequisite that becomes a troubleshooting step if absent
2. "This will be slow" — npm resolution is notably slower than binary downloads
3. "It won't auto-update" — npm global packages require explicit re-runs to update
4. "It's a Node.js tool" — which is accurate but positions DorkOS as "one of many npm CLIs" rather than infrastructure

When a developer sees `curl -fsSL https://dorkos.ai/install | bash`, they form different expectations:

1. "This is a first-class CLI tool with its own distribution channel"
2. "It probably auto-updates"
3. "It probably works on any system with a shell"
4. "The authors care about the install experience"

Claude Code's move from npm to native binary was not just technical optimization — it was a repositioning of the tool as serious infrastructure rather than an npm package. DorkOS should make the same move.

### The OpenClaw Onboarding Integration Pattern

OpenClaw's `openclaw onboard` step — run automatically at the end of the install script — is the most sophisticated onboarding integration observed. Rather than relying on users to discover a setup wizard, the installer delivers them directly to it. This is Fogg's Behavior Model applied correctly: maximum motivation (they just installed), maximum ability (one more command runs automatically), instant prompt (the installer triggers it).

For DorkOS, the equivalent would be:
```
DorkOS installed successfully.

Starting first-time setup...
Run: dorkos init

Or skip setup and start now:
Run: dorkos
```

Whether `dorkos init` runs automatically or is offered as the next step depends on how intrusive the team wants the first-run experience to be. The recommendation from the FTUE research (20260301_ftue_best_practices_deep_dive.md) is to offer but not force it.

### The Desktop App as Install Alternative

Claude Code's "Prefer a graphical interface?" tip at the top of the install docs is notable. By acknowledging that some users want to avoid the terminal and providing a desktop app, they convert potential abandonment (user who doesn't have a terminal setup) into adoption. OpenCode does the same with its desktop beta.

For DorkOS, this is a meaningful opportunity: the Obsidian plugin is already a non-terminal entry point for one persona (Priya). A desktop app wrapper would serve Kai's use case better than `npm install -g` if he's on a fresh machine. The desktop app download is simpler than any install script.

---

## Research Gaps and Limitations

- **OpenClaw's install script post-Steinberger transition:** With the creator joining OpenAI, the install script URL (openclaw.ai/install.sh) may change or become unmaintained. Findings are current as of 2026-03-01.
- **DorkOS binary compilation feasibility:** The recommendation to use `bun build --compile` is based on Bun's documented capabilities. The specific `better-sqlite3` → `bun:sqlite` migration effort has not been scoped.
- **Homebrew formula maintenance burden:** Creating and maintaining a Homebrew tap adds ongoing release work. Formula must be updated for each DorkOS release. This is manageable but should be factored into release process design.
- **Windows experience:** No competitor other than Claude Code has a first-class Windows terminal install experience. This is a gap across the board and not unique to DorkOS.

---

## Contradictions and Disputes

**`curl | bash` security:** The security community has documented legitimate risks (MITM, partial execution). However, all major developer CLI tools in DorkOS's competitive set use this pattern, and the target audience is sophisticated developers who accept this tradeoff. The mitigation (HTTPS + checksum + code signing) addresses the primary attack vectors. This is not an unconditional endorsement — DorkOS should implement checksum verification from the start.

**Auto-update opt-in vs. opt-out:** Claude Code auto-updates by default with an opt-out. DorkOS's FTUE research recommends respecting user control. The recommendation is auto-update on by default (matching Claude Code) with `DORKOS_DISABLE_AUTOUPDATER=1` as an explicit opt-out — consistent with the "self-confident software" principle from Alan Cooper (don't ask for confirmation unless necessary).

---

## Search Methodology

- Number of searches performed: 14
- Direct page fetches: 9
- Install scripts read: Claude Code (bootstrap.sh), OpenCode (anomalyco/opencode install), OpenClaw (openclaw.ai/install.sh)
- Most productive search terms: "Claude Code install.sh curl one-liner 2026", "OpenCode opencode.ai install script curl bash 2026", "Codex chatgpt.com install macOS npm CLI 2026", "npm global install vs curl install.sh developer tool tradeoffs"
- Primary sources: code.claude.com/docs, opencode.ai, openclaw.ai, developers.openai.com/codex, GitHub repositories for OpenCode and OpenClaw

---

## Sources

- [Claude Code Advanced Setup - Install Methods](https://code.claude.com/docs/en/setup)
- [Claude Code Quickstart - Step 1: Install](https://code.claude.com/docs/en/quickstart)
- [Claude Code bootstrap.sh (resolved from claude.ai/install.sh)](https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/bootstrap.sh)
- [OpenCode Download Page](https://opencode.ai/download)
- [OpenCode Install Script (GitHub)](https://raw.githubusercontent.com/anomalyco/opencode/refs/heads/dev/install)
- [OpenCode GitHub Repository](https://github.com/opencode-ai/opencode)
- [OpenClaw Home Page](https://openclaw.ai)
- [OpenClaw Install Script](https://openclaw.ai/install.sh)
- [Codex CLI Quickstart](https://developers.openai.com/codex/quickstart/)
- [Codex App Overview](https://developers.openai.com/codex/app/)
- [@openai/codex on npm](https://www.npmjs.com/package/@openai/codex)
- [Claude Code Installation Guide (vibecodingwithfred.com)](https://vibecodingwithfred.com/blog/claude-code-installation-guide/)
- [Curl to shell isn't so bad (arp242.net)](https://www.arp242.net/curl-to-sh.html)
- [The Dangers of curl | bash (lukespademan.com)](https://lukespademan.com/blog/the-dangers-of-curlbash/)
- [Lobsters: What's the problem with pipe-curl-into-sh?](https://lobste.rs/s/ymcbwl/what_s_problem_with_pipe_curl_into_sh)
- [When to Use Global NPM Installs? Rarely (DEV Community)](https://dev.to/tallyb/when-to-use-global-npm-installs-rarely-2dm3)
- [rustup Installation](https://rust-lang.github.io/rustup/installation/index.html)
- [Deno Installation](https://docs.deno.com/runtime/getting_started/installation/)
- [Bun Installation](https://bun.com/docs/installation)
- [What 202 Open Source Developers Taught Us About Tool Adoption](https://www.catchyagency.com/post/what-202-open-source-developers-taught-us-about-tool-adoption)
- Existing research: [CLI Self-Update Command Patterns](research/20260217_cli_self_update_patterns.md)
- Existing research: [FTUE Best Practices Deep Dive](research/20260301_ftue_best_practices_deep_dive.md)
- Existing research: [Competitive Marketing Analysis](research/20260217_competitive_marketing_analysis.md)

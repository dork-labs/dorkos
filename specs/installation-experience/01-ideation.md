---
slug: installation-experience
number: 81
created: 2026-03-01
status: ideation
---

# Best-in-Class Installation Experience

**Slug:** installation-experience
**Author:** Claude Code
**Date:** 2026-03-01

---

## 1) Intent & Assumptions

- **Task brief:** Research competitor installation experiences (Claude Code, OpenClaw, OpenCode, Codex) and design a best-in-class install flow for DorkOS. Analyze what their install scripts do. Create a plan for the methods we should offer and how they should be presented on the website.

- **Assumptions:**
  - DorkOS currently installs only via `npm install -g dorkos` — the only tool in its competitive set with a single install method
  - DorkOS is a Node.js application (Express + React + Claude Agent SDK) and cannot produce standalone binaries without a migration to Bun compile or similar
  - The target audience is expert developers who already use Claude Code — they are already comfortable with `curl | bash`
  - The existing CLI package (`packages/cli`) and init wizard (`dorkos init`) are the foundation to build on
  - The FTUE spec (#79) defines the web-side onboarding experience; this spec focuses on everything before the browser opens

- **Out of scope:**
  - Native binary compilation via Bun compile or pkg (Tier 2 — separate spec)
  - Desktop app wrapper (Tier 3 — separate spec)
  - Auto-update mechanism (requires binary distribution — separate spec)
  - The web UI onboarding flow (covered by FTUE spec #79)
  - IDE extensions or WinGet packages

---

## 2) Pre-reading Log

- `packages/cli/src/cli.ts`: Main entry point — flag parsing, config precedence merge (CLI flags > env vars > config file > defaults), first-run detection, startup banner output
- `packages/cli/src/init-wizard.ts`: 88-line interactive setup wizard using `@inquirer/prompts` — prompts for port, theme, tunnel, cwd. No descriptions for each question, no post-setup summary
- `packages/cli/src/check-claude.ts`: Prerequisite check — Claude Code CLI must be available in PATH
- `packages/cli/src/update-check.ts`: Non-blocking npm registry check (3-second timeout, 24-hour cache)
- `packages/cli/scripts/build.ts`: Three-step build pipeline (Vite client → esbuild server → esbuild CLI entry)
- `docs/getting-started/installation.mdx`: Three-tab docs (npm CLI, Obsidian Plugin, Self-Hosted) with per-package-manager commands
- `docs/getting-started/quickstart.mdx`: Post-install entry path — launch, first message, tool approval, interface exploration
- `apps/site/src/layers/features/marketing/ui/InstallMoment.tsx`: Homepage install section — shows `npm install -g dorkos` with scramble animation, badges, CTA buttons. Links to npm and docs
- `apps/site/src/layers/features/marketing/ui/ActivityFeedHero.tsx`: Hero section — `npm install -g dorkos` as CTA text, links to npm. Desktop shows npm command, mobile shows "Get started" linking to docs
- `apps/site/src/app/(marketing)/page.tsx`: Homepage composition — Hero, VillainSection, PivotSection, TimelineSection, SubsystemsSection, HonestySection, InstallMoment, TheClose
- `specs/first-time-user-experience/01-ideation.md`: FTUE spec covering the web-side onboarding flow (agent discovery, Pulse presets, adapter setup). Assumes CLI install is already complete
- `research/20260301_competitor_install_experience.md`: 540-line deep research report covering all four competitors, install script analysis, method comparison matrix, security considerations, and tiered recommendations
- `research/20260217_competitive_marketing_analysis.md`: Marketing positioning analysis — DorkOS gaps vs OpenClaw and Codex
- `research/20260217_cli_self_update_patterns.md`: Self-update patterns for npm-distributed CLIs — notification-only is the dominant pattern

---

## 3) Codebase Map

### Primary Components/Modules

**CLI Package (`packages/cli/`):**
- `src/cli.ts` (150 lines) — Entry point, parseArgs, environment setup, server import
- `src/init-wizard.ts` (88 lines) — Interactive setup (port, theme, tunnel, cwd)
- `src/check-claude.ts` — Claude CLI prerequisite validation
- `src/update-check.ts` — Async npm registry version check
- `src/config-commands.ts` — Subcommands: `dorkos config`, `dorkos init`
- `scripts/build.ts` — Orchestrates Vite + esbuild build pipeline
- `package.json` — Published as unscoped `dorkos` to npm, bin entry: `"dorkos": "./dist/bin/cli.js"`

**Marketing Site (`apps/site/`):**
- `src/layers/features/marketing/ui/InstallMoment.tsx` — Homepage install section with scramble animation
- `src/layers/features/marketing/ui/ActivityFeedHero.tsx` — Hero with npm install CTA
- `src/app/(marketing)/page.tsx` — Homepage composition

**Documentation (`docs/getting-started/`):**
- `installation.mdx` — Three-tab install page (npm CLI, Obsidian Plugin, Self-Hosted)
- `quickstart.mdx` — Post-install getting started guide
- `configuration.mdx` — Config reference

### Shared Dependencies

- `@inquirer/prompts` — Interactive CLI wizard prompts
- `conf` — Persistent config file at `~/.dork/config.json`
- `esbuild` — CLI and server bundling
- `vite` — React SPA build
- Fumadocs — Documentation site framework (Tabs, Steps, Callout components)

### Data Flow

```
[Website/Docs] → user copies install command
       ↓
[Terminal] → npm install -g dorkos (currently only method)
       ↓
[CLI] → dorkos command starts
       ↓
  ├─ Creates ~/.dork/ directory (first-run)
  ├─ Checks claude CLI in PATH
  ├─ Loads config precedence (flags > env > file > defaults)
  ├─ Optionally runs init wizard (--init flag or first-run)
  ├─ Starts Express server + serves React SPA
  └─ Prints startup banner with URL
       ↓
[Browser] → User opens localhost:PORT → web FTUE begins
```

### Feature Flags/Config

- `ANTHROPIC_API_KEY` — Required, but validated lazily (on first session, not on install)
- `DORKOS_PORT` — Default 4242
- `DORK_HOME` — Config directory, default `~/.dork`
- First-run detection: `ConfigManager.isFirstRun` checks if `~/.dork/config.json` exists

### Potential Blast Radius

**New files (low risk):**
- `install.sh` — New shell install script (served via site or GitHub)
- Homebrew formula repository (separate GitHub repo)
- Updated marketing site install components

**Modified files (medium risk):**
- `apps/site/src/layers/features/marketing/ui/InstallMoment.tsx` — Redesign with tabs
- `apps/site/src/layers/features/marketing/ui/ActivityFeedHero.tsx` — Update CTA
- `docs/getting-started/installation.mdx` — Add curl method as primary
- `docs/getting-started/quickstart.mdx` — Update prerequisites
- `packages/cli/src/cli.ts` — Add `--post-install-check` flag for install script verification

**No architectural risk:** All changes are additive. The existing npm install path is unchanged.

---

## 4) Root Cause Analysis

N/A — This is a new feature, not a bug fix.

---

## 5) Research

### Competitor Install Methods

| Tool | Primary Method | Other Methods | Install Script? | Auto-Update? |
|------|---------------|---------------|-----------------|--------------|
| **Claude Code** | `curl -fsSL https://claude.ai/install.sh \| bash` | Homebrew, WinGet, Desktop app, npm (deprecated) | Yes — SHA256 checksums, code signing, Rosetta 2 detection | Yes — binary self-replace |
| **OpenCode** | `curl -fsSL https://opencode.ai/install \| bash` | npm, bun, Homebrew, AUR, Go, Desktop app | Yes — AVX2 detection, no checksums | No |
| **OpenClaw** | `curl -fsSL https://openclaw.ai/install.sh \| bash` | npm, git clone | Yes — TUI spinner via gum, runs `openclaw onboard` at end | No |
| **Codex** | `npm install -g @openai/codex` | Homebrew, binary download, web app | No | No |
| **DorkOS** | `npm install -g dorkos` | — | No | No |

### What the Install Scripts Do

**Claude Code (bootstrap.sh) — Gold standard:**
1. Checks for `curl` or `wget`
2. OS detection (`uname -s`): Darwin, Linux; Windows exits with error
3. Arch detection (`uname -m`): x64, arm64
4. Rosetta 2 detection on macOS (downloads arm64 binary even under emulation)
5. Linux C library detection (glibc vs musl)
6. Downloads `manifest.json` with per-platform SHA256 checksums
7. Downloads platform-specific binary
8. Verifies SHA256 checksum; deletes and exits if mismatch
9. Installs to `~/.claude/downloads`, makes executable
10. Auto-update is built into the binary itself

**OpenClaw (install.sh) — Most feature-complete:**
1. OS/arch detection (including WSL)
2. Downloads `gum` (TUI library) for interactive spinner during install
3. Validates all dependencies: Node 22+, npm, git, pnpm, make/cmake/python3
4. Runs `npm install -g openclaw` with build-tools fallback on failure
5. Handles npm conflicts (stale directories, existing binaries)
6. PATH management for both npm and git install methods
7. Runs `openclaw onboard` at end (skippable with `--no-onboard`)
8. Holiday taglines based on current date

**OpenCode (install) — Cleanest binary approach:**
1. `set -euo pipefail` strict mode
2. OS/arch detection with AVX2 CPU feature detection
3. Downloads `.tar.gz` or `.zip` from GitHub releases
4. Installs to `~/.opencode/bin`
5. Shell-aware PATH management (bash/zsh/fish)
6. No checksum verification (security gap)
7. Supports `--dry-run`, `--version`, `--verbose` flags

### Why npm-Only Is a Problem

The research identified a perceptual gap:
- `npm install -g dorkos` signals "side project" — one of thousands of npm packages
- `curl -fsSL https://dorkos.ai/install | bash` signals "first-class infrastructure" — own distribution channel

Claude Code's migration from npm to native binary was as much a repositioning as a technical improvement. DorkOS serving the same audience should present the same level of install sophistication, even if the underlying mechanism still uses npm.

### The Hybrid Approach (OpenClaw Pattern)

Since DorkOS is a Node.js application that requires a runtime, the most practical immediate approach is OpenClaw's pattern: a `curl | bash` script that wraps `npm install -g` but adds:
- Node.js version detection and helpful error messages
- Dependency validation before install
- Clean post-install messaging
- Optional onboarding wizard prompt

This provides the `curl` UX without requiring binary compilation.

### Recommendation

**Three install methods, three tiers of effort:**

1. **curl install script** (wrapping npm) — Primary, recommended method. Provides the UX parity with competitors while keeping the existing npm distribution channel. Days of work.

2. **npm install -g dorkos** — Keep as-is, positioned as the alternative for users who prefer explicit package management. Zero work.

3. **Homebrew tap** — `brew install dorkos-ai/tap/dorkos`. Adds macOS discoverability. Requires a separate GitHub repo with a formula that wraps npm. A few hours of work plus ongoing release maintenance.

### Security Considerations

- The curl script must be served over HTTPS only
- For a wrapper script (not downloading arbitrary binaries), the security surface is limited to the npm install itself — which users would run anyway
- Future: when/if DorkOS moves to binary distribution, add SHA256 checksum verification and code signing

### Performance Considerations

- Install time remains dominated by npm resolution/download (~15-30 seconds depending on network)
- The curl script wrapper adds ~1 second of overhead (Node.js version check, dependency validation)
- Homebrew formula will be slightly slower (brew formula resolution + npm install)

---

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Install methods to offer | **curl script + npm + brew** (Tier 1) | Fastest path to parity with competitors. Every tool in our competitive set offers 3+ methods; we currently offer 1. The curl script wraps npm (like OpenClaw), the brew tap wraps npm. Days of work, not weeks. Native binary (Bun compile) is deferred to a separate spec |
| 2 | Post-install behavior | **Offer but don't force** | After install, prompt `Run setup wizard now? (y/N)`. Skips by default — pressing Enter continues without the wizard. Respects expert users while surfacing the option. The web UI FTUE handles deeper onboarding |
| 3 | Website install presentation | **Tabbed install with curl as default** | 3-tab UI (curl / npm / brew) on both the homepage InstallMoment and docs install page. Curl tab pre-selected. Copy-to-clipboard on each code block. Matches Claude Code's gold-standard pattern |
| 4 | Install script host URL | **dorkos.ai/install** | Clean, brandable URL. Served as a static file from the marketing site (Next.js public directory or API route). Version-pinnable: `curl ... \| bash -s 1.2.3` |
| 5 | Install script security | **HTTPS only, no checksum (for now)** | Since the script wraps npm (not downloading arbitrary binaries), the security surface is the same as running npm directly. Checksum verification becomes critical when/if we move to binary distribution |
| 6 | Script capabilities | **Node.js check + npm install + post-install message + optional init** | Detect Node.js 18+, run npm install, print clean completion message, ask about setup wizard. Support `--version`, `--no-prompt` (for CI), and `--dry-run` flags |
| 7 | Homebrew tap structure | **Separate GitHub repo: dork-labs/homebrew-dorkos** | Standard Homebrew tap pattern. Formula wraps `npm install -g dorkos`. Updated on each npm release. Minimal maintenance via GitHub Actions |
| 8 | Hero CTA update | **curl command replaces npm command** | The hero CTA (`ActivityFeedHero.tsx`) and install moment (`InstallMoment.tsx`) should show `curl -fsSL https://dorkos.ai/install \| bash` as the primary command. npm is one tab away |
| 9 | Mobile install UX | **"Get started" button linking to docs** | On mobile, show a "Get started" button linking to the docs install page (current pattern). The curl command is too long for mobile display. Docs page has the full tabbed experience |
| 10 | Docs install page update | **Add curl as first tab, keep existing content** | The existing `installation.mdx` has good content for npm, Obsidian, and Self-Hosted. Add curl as a new first tab, keep the other 3 tabs as-is. Reorder: curl (recommended) / npm / brew / Obsidian / Self-Hosted |

---

## Appendix: Install Script Draft

```bash
#!/usr/bin/env bash
set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────
DORKOS_VERSION="${1:-latest}"
DORKOS_NO_PROMPT="${DORKOS_NO_PROMPT:-0}"
DRY_RUN=0

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-prompt) DORKOS_NO_PROMPT=1 ;;
    --help)
      echo "Usage: curl -fsSL https://dorkos.ai/install | bash [-s VERSION]"
      echo ""
      echo "Flags (pass after -s --):"
      echo "  --dry-run     Show what would happen without installing"
      echo "  --no-prompt   Skip all interactive prompts (for CI)"
      echo "  --help        Show this help"
      echo ""
      echo "Examples:"
      echo "  curl -fsSL https://dorkos.ai/install | bash"
      echo "  curl -fsSL https://dorkos.ai/install | bash -s 1.2.3"
      echo "  curl -fsSL https://dorkos.ai/install | bash -s -- --dry-run"
      exit 0
      ;;
  esac
done

# ─── Dependency checks ───────────────────────────────────────────

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required but not installed."
  echo ""
  echo "Install Node.js 18+ from https://nodejs.org"
  echo "Or use nvm:"
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "  nvm install 22"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.version.split('.')[0].slice(1))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js 18+ is required. Current version: $(node --version)"
  echo ""
  echo "Upgrade Node.js: https://nodejs.org"
  exit 1
fi

# Check npm
if ! command -v npm &>/dev/null; then
  echo "Error: npm is required but not found."
  echo "npm is bundled with Node.js — reinstall Node.js from https://nodejs.org"
  exit 1
fi

# ─── Install ──────────────────────────────────────────────────────

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] Would run: npm install -g dorkos@${DORKOS_VERSION}"
  echo "[dry-run] Node.js $(node --version) ✓"
  echo "[dry-run] npm $(npm --version) ✓"
  exit 0
fi

echo "Installing DorkOS..."
echo ""

if [ "$DORKOS_VERSION" = "latest" ]; then
  npm install -g dorkos
else
  npm install -g "dorkos@${DORKOS_VERSION}"
fi

# ─── Post-install ─────────────────────────────────────────────────

INSTALLED_VERSION=$(dorkos --version 2>/dev/null || echo "unknown")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DorkOS ${INSTALLED_VERSION} installed."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Start:   dorkos"
echo "  Setup:   dorkos init"
echo "  Docs:    https://dorkos.ai/docs"
echo ""

# Offer setup wizard (non-CI only)
if [ "$DORKOS_NO_PROMPT" != "1" ] && [ -t 0 ]; then
  printf "Run setup wizard now? (y/N) "
  read -r answer
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    dorkos init
  fi
fi
```

## Appendix: Website Tabbed Install Component

The `InstallMoment.tsx` and docs `installation.mdx` should present install methods in a tabbed interface:

**Tab 1 — "One-liner" (pre-selected):**
```
curl -fsSL https://dorkos.ai/install | bash
```
Copy button. Subtext: "Checks Node.js, installs via npm, offers setup wizard."

**Tab 2 — "npm":**
```
npm install -g dorkos
```
Copy button. Subtext: "Requires Node.js 18+."

**Tab 3 — "Homebrew":**
```
brew install dorkos-ai/tap/dorkos
```
Copy button. Subtext: "macOS and Linux. Updates via brew upgrade."

## Appendix: Homebrew Formula

```ruby
class Dorkos < Formula
  desc "OS-layer for AI agents — scheduling, memory, and coordination"
  homepage "https://dorkos.ai"
  url "https://registry.npmjs.org/dorkos/-/dorkos-#{version}.tgz"
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", "--global", "--prefix", prefix, "dorkos@#{version}"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dorkos --version")
  end
end
```

## Appendix: Relationship to FTUE Spec (#79)

This spec covers the "before the browser opens" experience. The FTUE spec (#79) covers the "after the browser opens" experience. The handoff point is:

1. **This spec:** User runs install command → install completes → optional `dorkos init` wizard → `dorkos` starts → browser opens
2. **FTUE spec (#79):** Browser opens → first-time detection → functional onboarding (agent discovery, Pulse presets, adapter setup)

The install script's optional `dorkos init` is a CLI-side onboarding for configuration basics (port, theme, tunnel). The web FTUE is a rich visual onboarding for product activation (agents, schedules, adapters). They are complementary, not overlapping.

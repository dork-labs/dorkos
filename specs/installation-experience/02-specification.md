---
slug: installation-experience
number: 81
created: 2026-03-01
status: draft
spec: true
ideation: specs/installation-experience/01-ideation.md
---

# Best-in-Class Installation Experience

**Status:** Draft
**Authors:** Claude Code, 2026-03-01
**Ideation:** [specs/installation-experience/01-ideation.md](./01-ideation.md)
**Research:** [research/20260301_competitor_install_experience.md](../../research/20260301_competitor_install_experience.md)

---

## Overview

Add three install methods to DorkOS — a curl install script, Homebrew tap, and updated website/docs — to match competitor install experiences. DorkOS currently offers only `npm install -g dorkos`, making it the only tool in its competitive set (Claude Code, OpenClaw, OpenCode, Codex) with a single install method. This spec covers the "before the browser opens" experience; the FTUE spec (#79) covers the web-side onboarding after the browser opens.

The curl script wraps npm (the "hybrid" approach used by OpenClaw) to provide `curl | bash` UX without requiring binary compilation. This is the fastest path to install parity with competitors.

---

## Background / Problem Statement

Every competitor in DorkOS's space offers 3+ install methods with `curl | bash` as the dominant primary method:

| Tool | Primary Method | Total Methods |
|------|---------------|---------------|
| Claude Code | `curl \| bash` (native binary) | 5 |
| OpenCode | `curl \| bash` (binary) | 6 |
| OpenClaw | `curl \| bash` (wraps npm) | 3 |
| Codex | `npm install -g` | 4 |
| **DorkOS** | **`npm install -g`** | **1** |

The perceptual gap is significant: `npm install -g` signals "side project" (one of thousands of npm packages), while `curl -fsSL https://dorkos.ai/install | bash` signals "first-class infrastructure" (own distribution channel). Claude Code's migration from npm to native binary was as much a repositioning as a technical improvement.

---

## Goals

- Provide three install methods: curl script (primary), npm (secondary), Homebrew (tertiary)
- Present a tabbed install UI on both the homepage and docs with curl pre-selected
- Serve the install script at `https://dorkos.ai/install`
- Support CI/automation via `--no-prompt` and `--dry-run` flags
- Offer (but not force) the setup wizard after install
- Maintain full backward compatibility with existing npm install

## Non-Goals

- Native binary compilation via Bun compile or pkg (separate spec)
- Desktop app wrapper (separate spec)
- Auto-update mechanism (requires binary distribution)
- Web UI onboarding flow (covered by FTUE spec #79)
- IDE extensions or WinGet packages
- SHA256 checksum verification or code signing (needed only for binary distribution)

---

## Technical Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| Next.js | 16 | API route for install script serving |
| Fumadocs | Current | Tabs, Steps, Callout MDX components for docs |
| motion | Current | Marketing site animations |
| node:util parseArgs | Node 18+ | CLI flag parsing |
| Homebrew | N/A | External tap repository |

No new npm dependencies are required. All changes use existing framework capabilities.

---

## Detailed Design

### 1. Install Script (`apps/site/src/app/install/route.ts`)

A Next.js Route Handler that serves a bash script with `Content-Type: text/plain`. This approach is preferred over a static file in `public/` because:
- Route Handlers support edge caching and headers control
- The script can be versioned alongside the site code
- URL stays clean: `dorkos.ai/install` (no file extension)

**Route Handler:**

```typescript
// apps/site/src/app/install/route.ts
import { NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const script = readFileSync(
  join(process.cwd(), 'scripts', 'install.sh'),
  'utf-8',
)

export function GET() {
  return new NextResponse(script, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
    },
  })
}
```

**Install script** (`apps/site/scripts/install.sh`):

The script follows the hybrid approach (OpenClaw pattern): wraps `npm install -g` but adds dependency validation, error handling, and post-install messaging.

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

# ─── Verify ───────────────────────────────────────────────────────

if ! command -v dorkos &>/dev/null; then
  echo ""
  echo "Warning: 'dorkos' command not found in PATH after install."
  echo "You may need to restart your terminal or add npm's global bin to PATH."
  echo ""
  echo "Try: export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
  exit 1
fi

# ─── Post-install ─────────────────────────────────────────────────

INSTALLED_VERSION=$(dorkos --version 2>/dev/null || echo "unknown")

echo ""
echo "  DorkOS ${INSTALLED_VERSION} installed successfully."
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

**Key design decisions:**
- `set -euo pipefail` for strict error handling (matches OpenCode pattern)
- Version pinning: `curl ... | bash -s 1.2.3` passes version as `$1`
- CI mode: `--no-prompt` flag OR `DORKOS_NO_PROMPT=1` env var OR non-interactive stdin (`[ -t 0 ]`)
- Post-install PATH verification: catches the common case where npm global bin is not in PATH
- Setup wizard prompt defaults to No (pressing Enter skips) — respects expert users

### 2. Website Install UI Updates

#### 2a. InstallMoment.tsx Redesign

The current `InstallMoment.tsx` hardcodes `npm install -g dorkos` with a text scramble animation. Redesign to add a 3-tab interface while preserving the visual identity (badges, tagline, film-grain background).

**Changes:**
- Add `useState` for active tab (default: `'curl'`)
- Replace single command display with tab-switching UI
- Each tab shows a different install command with copy-to-clipboard
- Preserve the `useTextScramble` animation on the initially-visible curl command
- Keep all existing badge, tagline, and CTA elements

**Tab data structure:**

```typescript
const INSTALL_METHODS = [
  {
    id: 'curl',
    label: 'One-liner',
    command: 'curl -fsSL https://dorkos.ai/install | bash',
    description: 'Checks Node.js, installs via npm, offers setup wizard.',
  },
  {
    id: 'npm',
    label: 'npm',
    command: 'npm install -g dorkos',
    description: 'Requires Node.js 18+.',
  },
  {
    id: 'brew',
    label: 'Homebrew',
    command: 'brew install dorkos-ai/tap/dorkos',
    description: 'macOS and Linux. Updates via brew upgrade.',
  },
] as const
```

**Tab UI pattern:**
- Three tab buttons in a row, matching the `bg-cream-secondary` terminal aesthetic
- Active tab: `border-b-2 border-[#E85D04]` (accent orange) with `text-[#44403C]`
- Inactive tab: `text-[#7A756A]` (muted)
- Tab content area: same `bg-cream-secondary rounded-lg px-8 py-5` as current terminal block
- Copy button appears on hover (right side of command), uses `navigator.clipboard.writeText()`
- Description text below command in `text-xs text-[#7A756A]`

**CTA updates:**
- Desktop primary CTA: change text to `curl -fsSL https://dorkos.ai/install | bash` and link to `#install` (scroll anchor)
- Mobile primary CTA: keep "Get started" linking to `/docs/getting-started/quickstart`

#### 2b. ActivityFeedHero.tsx CTA Update

The `ActivityFeedHero` receives `ctaText` and `ctaHref` as props. No component changes needed — only the props passed from `page.tsx` change.

#### 2c. page.tsx Props Update

```tsx
// Before
<ActivityFeedHero
  ctaText="npm install -g dorkos"
  ctaHref={siteConfig.npm}
  githubHref={siteConfig.github}
/>

// After
<ActivityFeedHero
  ctaText="curl -fsSL https://dorkos.ai/install | bash"
  ctaHref="/docs/getting-started/installation"
  githubHref={siteConfig.github}
/>
```

The CTA link changes from the npm page to the installation docs page, where users see the full tabbed experience.

### 3. Documentation Updates

#### 3a. installation.mdx

Add curl as the first tab, brew as a new tab, reorder to: `One-liner (Recommended)` / `npm` / `Homebrew` / `Obsidian Plugin` / `Self-Hosted`.

**New tab structure:**

```mdx
<Tabs items={['One-liner (Recommended)', 'npm', 'Homebrew', 'Obsidian Plugin', 'Self-Hosted']}>

<Tab value="One-liner (Recommended)">
<Steps>
<Step>
### Install DorkOS

```bash
curl -fsSL https://dorkos.ai/install | bash
```

The install script checks for Node.js 18+, installs DorkOS via npm,
and optionally runs the setup wizard.

</Step>
<Step>
### Set your API key

```bash
export ANTHROPIC_API_KEY="your-key-here"
```

</Step>
<Step>
### Start DorkOS

```bash
dorkos
```

</Step>
</Steps>

<Callout type="info">
**CI/Automation:** Use `--no-prompt` to skip interactive prompts:
```bash
curl -fsSL https://dorkos.ai/install | bash -s -- --no-prompt
```
Pin a specific version: `curl -fsSL https://dorkos.ai/install | bash -s 1.2.3`
</Callout>
</Tab>

<Tab value="Homebrew">
<Steps>
<Step>
### Install DorkOS

```bash
brew install dorkos-ai/tap/dorkos
```

</Step>
<Step>
### Set your API key

```bash
export ANTHROPIC_API_KEY="your-key-here"
```

</Step>
<Step>
### Start DorkOS

```bash
dorkos
```

</Step>
</Steps>
</Tab>

<!-- Existing npm, Obsidian Plugin, Self-Hosted tabs unchanged -->
</Tabs>
```

#### 3b. quickstart.mdx

Update the prerequisites section to mention curl as the primary method:

```markdown
- **Node.js 18+** installed
- **Claude Code CLI** installed and authenticated (`claude` must be available in your PATH)
- **DorkOS** installed via `curl -fsSL https://dorkos.ai/install | bash` (or `npm install -g dorkos`)
```

### 4. Homebrew Tap

A separate GitHub repository `dork-labs/homebrew-dorkos` containing a single formula.

**Formula** (`Formula/dorkos.rb`):

```ruby
class Dorkos < Formula
  desc "OS-layer for AI agents — scheduling, memory, and coordination"
  homepage "https://dorkos.ai"
  url "https://registry.npmjs.org/dorkos/-/dorkos-0.5.0.tgz"
  sha256 "PLACEHOLDER_SHA256"
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

**Release automation:** A GitHub Action in the main repo triggers on npm publish, updates the formula version and SHA256 in the tap repo via the GitHub API.

### 5. CLI `--post-install-check` Flag

Add a lightweight flag to `packages/cli/src/cli.ts` that the install script can call to verify the installation succeeded without starting the server.

**Implementation:**

```typescript
// In parseArgs options:
'post-install-check': { type: 'boolean', default: false },

// Early exit handler (before server startup):
if (values['post-install-check']) {
  await checkClaude()
  console.log(`dorkos ${__CLI_VERSION__}`)
  console.log('Installation verified.')
  process.exit(0)
}
```

This runs the Claude CLI check (`checkClaude()`) and prints the version, confirming the CLI binary is functional and Claude is available. The install script does not use this flag in the initial implementation but it provides a hook for future install script enhancements.

---

## User Experience

### Install Flow (Primary — curl)

```
User visits dorkos.ai
  → Sees tabbed install with "One-liner" pre-selected
  → Copies: curl -fsSL https://dorkos.ai/install | bash
  → Runs in terminal
  → Script checks Node.js 18+ ✓
  → Script checks npm ✓
  → Runs npm install -g dorkos
  → Prints success message with next steps
  → Prompts: "Run setup wizard now? (y/N)"
  → User presses Enter (skips) or types y (runs dorkos init)
  → User runs: dorkos
  → Browser opens → web FTUE begins (spec #79)
```

### Install Flow (Alternative — npm)

```
User visits dorkos.ai
  → Clicks "npm" tab
  → Copies: npm install -g dorkos
  → Runs in terminal (existing flow, unchanged)
```

### Install Flow (Alternative — Homebrew)

```
User visits dorkos.ai
  → Clicks "Homebrew" tab
  → Copies: brew install dorkos-ai/tap/dorkos
  → Runs in terminal
  → Homebrew installs Node.js 22 (if needed) and dorkos
```

### Error States

| Scenario | Script Behavior |
|---|---|
| Node.js not installed | Error with install instructions (nodejs.org + nvm) |
| Node.js < 18 | Error with current version and upgrade link |
| npm not found | Error explaining npm is bundled with Node.js |
| npm install fails | npm error output shown; script exits with npm's exit code |
| `dorkos` not in PATH after install | Warning with PATH fix command |
| Non-interactive stdin (piped, CI) | Skips setup wizard prompt automatically |

---

## Testing Strategy

### Install Script Tests

Shell script testing using a test harness that mocks commands:

```bash
# test/install-script.test.sh

# Test: Node.js version check rejects old versions
test_rejects_old_node() {
  # Mock node to report v16
  node() { echo "v16.20.0"; }
  export -f node

  output=$(bash scripts/install.sh 2>&1) && fail "Expected exit 1"
  assert_contains "$output" "Node.js 18+ is required"
}

# Test: Dry run does not install
test_dry_run() {
  output=$(bash scripts/install.sh --dry-run 2>&1)
  assert_contains "$output" "[dry-run] Would run: npm install -g dorkos@latest"
  assert_not_contains "$output" "Installing DorkOS"
}

# Test: Version pinning
test_version_pin() {
  output=$(bash scripts/install.sh --dry-run 1.2.3 2>&1)
  assert_contains "$output" "dorkos@1.2.3"
}

# Test: CI mode skips prompt
test_ci_mode() {
  DORKOS_NO_PROMPT=1 output=$(echo "" | bash scripts/install.sh --dry-run 2>&1)
  assert_not_contains "$output" "Run setup wizard"
}
```

### CLI `--post-install-check` Tests

```typescript
// packages/cli/src/__tests__/cli-flags.test.ts
describe('--post-install-check', () => {
  it('exits 0 when claude CLI is available', async () => {
    // Mock checkClaude to succeed
    vi.mock('../check-claude', () => ({ checkClaude: vi.fn() }))
    // Verify process.exit(0) is called
  })

  it('exits 1 when claude CLI is not available', async () => {
    // Mock checkClaude to throw
    vi.mock('../check-claude', () => ({
      checkClaude: vi.fn().mockRejectedValue(new Error('not found')),
    }))
  })
})
```

### Website Component Tests

```typescript
// apps/site/src/layers/features/marketing/ui/__tests__/InstallMoment.test.tsx
describe('InstallMoment', () => {
  it('renders curl command by default', () => {
    render(<InstallMoment />)
    expect(screen.getByText(/curl -fsSL/)).toBeInTheDocument()
  })

  it('switches to npm tab on click', async () => {
    const user = userEvent.setup()
    render(<InstallMoment />)
    await user.click(screen.getByRole('tab', { name: 'npm' }))
    expect(screen.getByText('npm install -g dorkos')).toBeInTheDocument()
  })

  it('copies command to clipboard', async () => {
    const user = userEvent.setup()
    render(<InstallMoment />)
    await user.click(screen.getByRole('button', { name: /copy/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'curl -fsSL https://dorkos.ai/install | bash',
    )
  })
})
```

### Install Script Route Test

```typescript
// apps/site/src/app/install/__tests__/route.test.ts
describe('GET /install', () => {
  it('returns text/plain content type', async () => {
    const response = await GET()
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
  })

  it('returns script starting with shebang', async () => {
    const response = await GET()
    const text = await response.text()
    expect(text).toStartWith('#!/usr/bin/env bash')
  })

  it('sets cache headers', async () => {
    const response = await GET()
    expect(response.headers.get('Cache-Control')).toContain('public')
  })
})
```

### Manual Testing Checklist

- [ ] `curl -fsSL http://localhost:3000/install | bash` works locally
- [ ] `curl ... | bash -s -- --dry-run` shows dry-run output
- [ ] `curl ... | bash -s -- --help` shows usage
- [ ] `curl ... | bash -s 0.5.0` installs specific version
- [ ] Script fails gracefully without Node.js
- [ ] Script fails gracefully with Node.js < 18
- [ ] Post-install wizard prompt appears and defaults to No
- [ ] `DORKOS_NO_PROMPT=1` skips wizard prompt
- [ ] Website tabs switch correctly on desktop
- [ ] Mobile shows "Get started" button (no curl command)
- [ ] Copy-to-clipboard works on all three tabs
- [ ] Docs installation page shows all 5 tabs in correct order
- [ ] `brew install dorkos-ai/tap/dorkos` works (after tap repo creation)

---

## Performance Considerations

- **Install time:** Unchanged — dominated by npm resolution/download (~15-30s). The curl script wrapper adds ~1s overhead for Node.js version check.
- **Website:** Tab switching is instant (client-side state, no network). The `useTextScramble` animation only runs on the initial curl command, not on tab switch.
- **Script serving:** Route Handler returns a pre-read static string. Cache-Control headers enable CDN caching (5min client, 1hr edge). The script is ~2KB.
- **Homebrew:** Formula resolution adds ~5s to install time vs direct npm. Acceptable tradeoff for discoverability.

---

## Security Considerations

- **HTTPS only:** The install script is served over HTTPS via Vercel. The `curl -fsSL` flags enforce TLS (`-f` fail silently on HTTP errors, `-s` silent, `-S` show errors, `-L` follow redirects).
- **No arbitrary binary download:** Unlike Claude Code's bootstrap.sh, this script does not download platform-specific binaries. It runs `npm install -g`, which is the same command users would run manually. The security surface is identical.
- **No checksum verification needed:** Checksum verification protects against tampered binary downloads. Since this script wraps npm (which has its own integrity checks via `package-lock.json` and registry signatures), additional checksums are unnecessary.
- **Script content is static:** The Route Handler returns a pre-read file, not dynamically generated content. No user input is interpolated into the script.
- **Version argument sanitization:** The `$1` positional parameter is passed directly to npm as a version specifier. npm validates this internally; invalid version strings cause npm to exit with an error.

---

## Documentation

| Document | Change |
|---|---|
| `docs/getting-started/installation.mdx` | Add "One-liner (Recommended)" and "Homebrew" tabs |
| `docs/getting-started/quickstart.mdx` | Update prerequisites to show curl as primary |
| `CLAUDE.md` | No changes needed (CLI flags section is generic) |
| `contributing/` guides | No changes needed |

---

## Implementation Phases

### Phase 1: Install Script + CLI Flag

1. Create `apps/site/scripts/install.sh` with the full script
2. Create `apps/site/src/app/install/route.ts` Route Handler
3. Add `--post-install-check` flag to `packages/cli/src/cli.ts`
4. Add shell script tests and Route Handler tests
5. Verify locally: `curl -fsSL http://localhost:3000/install | bash --dry-run`

### Phase 2: Website UI Updates

1. Redesign `InstallMoment.tsx` with 3-tab interface
2. Update `page.tsx` props for `ActivityFeedHero` (ctaText, ctaHref)
3. Add copy-to-clipboard functionality
4. Add component tests
5. Verify mobile vs desktop rendering

### Phase 3: Documentation Updates

1. Update `installation.mdx` — add curl and brew tabs, reorder
2. Update `quickstart.mdx` — update prerequisites section
3. Verify Fumadocs rendering locally

### Phase 4: Homebrew Tap (External)

1. Create `dork-labs/homebrew-dorkos` GitHub repository
2. Add `Formula/dorkos.rb` with npm-wrapping formula
3. Set up GitHub Action for auto-updating formula on npm publish
4. Test: `brew tap dorkos-ai/tap && brew install dorkos`

---

## Open Questions

1. ~~**Install Script Serving Method**~~ (RESOLVED)
   **Answer:** Next.js Route Handler at `apps/site/src/app/install/route.ts`
   **Rationale:** Provides cache control headers and keeps URL clean (`/install` without extension). Static files in `public/` cannot set custom response headers.

   Original context preserved:
   - Option A: Next.js Route Handler at `apps/site/src/app/install/route.ts` (recommended)
   - Option B: Static file at `apps/site/public/install`

2. ~~**Homebrew Tap GitHub Organization**~~ (RESOLVED)
   **Answer:** Use `dork-labs/homebrew-dorkos` (aligning with the existing GitHub org)
   **Rationale:** The tap install command will be `brew install dork-labs/tap/dorkos`. Using the existing org avoids creating a new GitHub organization.

   Original context preserved:
   - Option A: `dork-labs/homebrew-dorkos` (matches existing org)
   - Option B: `dorkos-ai/homebrew-dorkos`

3. ~~**Text Scramble Animation Scope**~~ (RESOLVED)
   **Answer:** Only animate the curl command on initial page load
   **Rationale:** Animation on every tab switch would be distracting and feel unpolished. The scramble effect is a first-impression flourish, not a navigation interaction.

   Original context preserved:
   - Option A: Only animate the curl command on initial page load (recommended)
   - Option B: Re-run scramble animation on each tab switch

---

## Related ADRs

- **ADR 0054 — Invert Feature Flags to Enabled by Default** — Relevant because new installs should have Pulse, Relay, and Mesh active without requiring explicit opt-in. The install script does not set feature flags; they default to enabled per this ADR.
- **ADR 0056 — Persist Onboarding State Server-Side in Config** — The install script's optional `dorkos init` writes to `~/.dork/config.json`, which is the same config file used for onboarding state persistence.

---

## References

- [Ideation document](./01-ideation.md) — Full competitor analysis, install script draft, design decisions
- [Competitor install experience research](../../research/20260301_competitor_install_experience.md) — 540-line deep research report
- [FTUE spec #79](../first-time-user-experience/01-ideation.md) — Web-side onboarding (complementary)
- [CLI package source](../../packages/cli/src/cli.ts) — Current CLI entry point
- [InstallMoment.tsx](../../apps/site/src/layers/features/marketing/ui/InstallMoment.tsx) — Current homepage install section
- [installation.mdx](../../docs/getting-started/installation.mdx) — Current install docs

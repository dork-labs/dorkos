# Installation Experience — Task Breakdown

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-03-01
**Mode:** Full decomposition (4 phases, 9 tasks)

---

## Phase 1: Install Script + CLI Flag

The foundational phase: create the bash install script, serve it via a Next.js route handler, and add a CLI verification flag.

| ID  | Task                                                                 | Size   | Priority | Dependencies |
| --- | -------------------------------------------------------------------- | ------ | -------- | ------------ |
| 1.1 | Create bash install script at `apps/site/scripts/install.sh`         | Medium | High     | —            |
| 1.2 | Create Next.js Route Handler at `apps/site/src/app/install/route.ts` | Small  | High     | 1.1          |
| 1.3 | Add `--post-install-check` flag to `packages/cli/src/cli.ts`         | Small  | High     | —            |

**Parallel:** 1.1 and 1.3 can run in parallel. 1.2 depends on 1.1 (needs the script file to serve).

### 1.1 — Create bash install script

**File:** `apps/site/scripts/install.sh` (new)

The install script wraps `npm install -g dorkos` with:

- `set -euo pipefail` strict mode
- Node.js 18+ version check with install instructions (nodejs.org + nvm)
- npm availability check
- `--dry-run` flag (shows what would happen without installing)
- `--no-prompt` flag (skips interactive prompts for CI)
- `--help` flag with usage and examples
- `DORKOS_NO_PROMPT=1` env var support
- Version pinning via positional argument (`bash -s 1.2.3`)
- Post-install PATH verification
- Success message with next steps
- Optional setup wizard prompt (defaults to No, skipped in non-interactive terminals)

### 1.2 — Create Next.js Route Handler

**File:** `apps/site/src/app/install/route.ts` (new)

Route Handler that reads the script at module load time and returns it with:

- `Content-Type: text/plain; charset=utf-8`
- `Cache-Control: public, max-age=300, s-maxage=3600`

**Test file:** `apps/site/src/app/install/__tests__/route.test.ts` — verifies content type, shebang, and cache headers.

### 1.3 — Add `--post-install-check` flag

**File:** `packages/cli/src/cli.ts` (modify)

Adds `'post-install-check': { type: 'boolean', default: false }` to parseArgs options. Early exit handler runs `checkClaude()`, prints version and "Installation verified.", exits 0. Positioned before DORK_HOME setup for minimal side effects.

---

## Phase 2: Website UI Updates

Update the marketing site homepage to feature the curl one-liner as the primary install method with a tabbed interface.

| ID  | Task                                              | Size  | Priority | Dependencies |
| --- | ------------------------------------------------- | ----- | -------- | ------------ |
| 2.1 | Redesign `InstallMoment.tsx` with 3-tab interface | Large | High     | —            |
| 2.2 | Update `page.tsx` ActivityFeedHero props          | Small | High     | —            |

**Parallel:** 2.1 and 2.2 can run in parallel (different files, no code dependency).

### 2.1 — Redesign InstallMoment.tsx

**File:** `apps/site/src/layers/features/marketing/ui/InstallMoment.tsx` (modify)

Major changes:

- Add `INSTALL_METHODS` constant with 3 tab definitions (curl, npm, brew)
- Add `useState` for active tab (default: `'curl'`) and copied state
- Tab UI: 3 buttons with active/inactive styling (`border-b-2 border-[#E85D04]` / `text-[#7A756A]`)
- Terminal block shows active tab's command with `$ ` prefix and cursor blink
- Copy-to-clipboard button on hover (right side), shows checkmark for 2s after copy
- Description text below command in `text-xs text-[#7A756A]`
- `useTextScramble` only animates the curl command on initial view, not on tab switch
- Desktop CTA links to `#install` scroll anchor, mobile CTA stays "Get started"
- Section gets `id="install"` attribute

**Test file:** `apps/site/src/layers/features/marketing/ui/__tests__/InstallMoment.test.tsx` — 5 tests for tab switching, clipboard, descriptions.

### 2.2 — Update page.tsx props

**File:** `apps/site/src/app/(marketing)/page.tsx` (modify)

Two prop changes on `ActivityFeedHero`:

- `ctaText`: `"npm install -g dorkos"` -> `"curl -fsSL https://dorkos.ai/install | bash"`
- `ctaHref`: `{siteConfig.npm}` -> `"/docs/getting-started/installation"`

---

## Phase 3: Documentation Updates

Update the Fumadocs documentation to feature curl as the primary install method.

| ID  | Task                                                   | Size   | Priority | Dependencies |
| --- | ------------------------------------------------------ | ------ | -------- | ------------ |
| 3.1 | Rewrite `installation.mdx` with curl and Homebrew tabs | Medium | High     | —            |
| 3.2 | Update `quickstart.mdx` prerequisites                  | Small  | High     | —            |

**Parallel:** 3.1 and 3.2 can run in parallel.

### 3.1 — Rewrite installation.mdx

**File:** `docs/getting-started/installation.mdx` (modify)

- Tab order changes from `['npm CLI', 'Obsidian Plugin', 'Self-Hosted']` to `['One-liner (Recommended)', 'npm', 'Homebrew', 'Obsidian Plugin', 'Self-Hosted']`
- New "One-liner (Recommended)" tab with curl command, Steps, and CI/automation Callout
- New "Homebrew" tab with `brew install dorkos-ai/tap/dorkos`
- Existing npm tab renamed from "npm CLI" to "npm"
- Updating section gets matching One-liner and Homebrew tabs

### 3.2 — Update quickstart.mdx prerequisites

**File:** `docs/getting-started/quickstart.mdx` (modify)

Single bullet change: `"DorkOS installed globally via npm install -g dorkos"` becomes `"DorkOS installed via curl -fsSL https://dorkos.ai/install | bash (or npm install -g dorkos)"`.

---

## Phase 4: Homebrew Tap (External)

Create and automate the Homebrew tap repository. This is external to the monorepo and lower priority.

| ID  | Task                                                 | Size   | Priority | Dependencies |
| --- | ---------------------------------------------------- | ------ | -------- | ------------ |
| 4.1 | Create `dork-labs/homebrew-dorkos` repo with formula | Medium | Low      | —            |
| 4.2 | Set up GitHub Action for auto-updating formula       | Medium | Low      | 4.1          |

### 4.1 — Create Homebrew tap repo

**Repo:** `github.com/dork-labs/homebrew-dorkos` (new external repo)

Contains `Formula/dorkos.rb` with:

- `desc`, `homepage`, `license` metadata
- `depends_on "node@22"`
- `url` pointing to npm registry tarball
- `sha256` hash of the tarball
- `npm install --global --prefix` install command
- Test block verifying `--version` output

### 4.2 — GitHub Action for formula updates

**File:** `.github/workflows/update-homebrew.yml` (new, in main repo)

Workflow triggers on npm publish completion or manual dispatch. Fetches new version, computes SHA256, updates formula via sed, commits and pushes to the tap repo using `HOMEBREW_TAP_TOKEN` secret.

---

## Dependency Graph

```
Phase 1:
  1.1 (install script) ──> 1.2 (route handler)
  1.3 (CLI flag)        ──> (independent)

Phase 2:
  2.1 (InstallMoment)   ──> (independent)
  2.2 (page.tsx props)   ──> (independent)

Phase 3:
  3.1 (installation.mdx) ──> (independent)
  3.2 (quickstart.mdx)   ──> (independent)

Phase 4:
  4.1 (tap repo)         ──> 4.2 (GH Action)
```

Phases 1-3 are independent and can be worked in parallel across agents. Phase 4 can start anytime but is lower priority.

## Summary

| Metric         | Value                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| Total tasks    | 9                                                                         |
| Small tasks    | 5                                                                         |
| Medium tasks   | 3                                                                         |
| Large tasks    | 1                                                                         |
| High priority  | 7                                                                         |
| Low priority   | 2                                                                         |
| New files      | 5 (install.sh, route.ts, route test, InstallMoment test, GH Action)       |
| Modified files | 4 (cli.ts, InstallMoment.tsx, page.tsx, installation.mdx, quickstart.mdx) |
| External repos | 1 (dork-labs/homebrew-dorkos)                                             |

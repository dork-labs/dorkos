---
title: 'Dev-Mode Version Display & Upgrade UX: Research Report'
date: 2026-03-10
type: external-best-practices
status: active
tags: [versioning, update-notification, dev-mode, cli, web-ui, semver, upgrade-ux]
feature_slug: dev-version-display-upgrade-ux
searches_performed: 18
sources_count: 28
---

# Dev-Mode Version Display & Upgrade UX

**Date**: 2026-03-10
**Mode**: Deep Research
**Objective**: How do popular dev tools handle version display and update notifications when running in dev mode (from source), where the version resolves to `0.0.0`? What is the right approach for DorkOS?

---

## Research Summary

The core problem — a developer tool that shows "Upgrade available" because `0.0.0` (the dev build version) is always less than the latest published release — is a widely recognized issue with a well-established set of solutions. The dominant pattern across Go CLI tools (GitHub CLI, Containerlab), web servers (Grafana), and JavaScript tools is to skip update checks when running a dev build. Detection methods vary: sentinel versions (`0.0.0-dev`), git-describe patterns, environment variables (`NODE_ENV`, `CI`), or explicit flags. The `update-notifier` package (used by DorkOS's CLI) does **not** have built-in `0.0.0` detection and will always report an update as available if the registered version is `0.0.0`. For the web UI status bar, the correct fix is to have the server communicate its "effective version mode" to the client, so the UI can show "Dev" instead of a false upgrade notice.

---

## Key Findings

### 1. The Core Bug: `update-notifier` Has No 0.0.0 Exemption

The `update-notifier` package by Sindre Sorhus skips update checks only for these conditions:

- `NO_UPDATE_NOTIFIER` env var is set (any value)
- `NODE_ENV=test`
- `--no-update-notifier` flag is passed
- CI environment detected (`CI`, `BUILD_NUMBER`, `RUN_ID` env vars)
- Config `optOut` is set
- Update check interval has not elapsed

**It does not skip for `0.0.0` versions or any version pattern.** Since `semver.gt('1.2.3', '0.0.0')` is `true`, `update-notifier` will always surface a notification when running from source with `version: "0.0.0"` in `package.json`.

### 2. GitHub CLI's Approach: Git-Describe Regex Detection

The GitHub CLI (`gh`) uses a regex to detect development builds. In `internal/update/update.go`:

```go
gitDescribeSuffixRE = regexp.MustCompile(`\d+-\d+-g[a-f0-9]{8}$`)
```

When the version string matches this pattern (e.g., `1.2.3-14-gabcdef`), it converts the version to a pre-release format, which prevents dev builds from being flagged as outdated. Additionally, `gh` skips update checks when:

- `GH_NO_UPDATE_NOTIFIER` is set
- `CODESPACES` env var is present
- stdout/stderr is not a terminal
- `CI`, `BUILD_NUMBER`, or `RUN_ID` env vars are present
- A check occurred within the last 24 hours

This is the gold standard Go implementation — pattern-match the version string, convert to pre-release format, skip gracefully.

### 3. Containerlab's Approach: 0.0.0 + Commit Hash Combination

Containerlab (a popular network simulation CLI, ~8k GitHub stars) uses a two-part dev version strategy:

- The `Makefile` sets `Version=0.0.0` for local builds
- The short git commit hash is injected separately: `COMMIT_HASH=$(git rev-parse --short HEAD)`
- Version output: `Version: 0.0.0, Commit: a3f5c12`
- Update checks can be disabled by setting `CLAB_VERSION_CHECK=disable` (case-insensitive substring match)

The `0.0.0` version string alone is used as the sentinel — the upgrade check logic explicitly handles it: if `Version == "0.0.0"`, the version is considered a development build and update notifications are suppressed.

### 4. Grafana's Approach: Config Flag to Suppress Check

Grafana (self-hosted observability platform) exposes `[updates] check_update_grafana_com = false` in `grafana.ini`. Developers running from source set this to `false` to suppress the "upgrade available" banner in the UI. There is no automatic detection — it requires explicit opt-out via configuration.

This is inferior to automatic detection (requires manual developer action) but is a reasonable backup mechanism for any approach.

### 5. VS Code's Approach: "Quality" Channel Detection

VS Code uses a concept called "quality" (`stable`, `insider`, `exploration`). When built from source, the quality is effectively undefined / not matching a distributed channel. VS Code's update service (`src/vs/platform/update/`) checks the quality channel before attempting update checks — if quality doesn't match a known distribution channel, update checks are skipped entirely. The build pipeline injects the correct quality string; local source builds have no quality string, which is treated as "non-updatable."

This is the most robust approach for a product with multiple distribution channels, but it adds architectural complexity.

### 6. Semver Rules: `0.0.0-dev` vs `0.0.0`

Per semver.org:

- `0.0.0` is a valid semver (major 0, minor 0, patch 0)
- `0.0.0-dev` is a pre-release version, **always lower** in precedence than `0.0.0`
- `0.0.0-dev.sha.abcdef` is also valid and even lower

**The critical semver behavior**: `semver.gt('1.2.3', '0.0.0-dev')` is `true`. So `0.0.0-dev` does NOT help automatically suppress `update-notifier` notifications — the library would still report `1.2.3` as newer than `0.0.0-dev`.

The value of `0.0.0-dev` over plain `0.0.0` is that it signals intent **in the version string itself** — it's a readable indicator that this is a development build, not a broken/pre-first-release version. But for update check suppression, you still need explicit logic.

### 7. The Correct Mechanism: Explicit Dev Detection Logic

The correct pattern (used by GitHub CLI, Containerlab) is:

```typescript
function isDevBuild(version: string): boolean {
  // Sentinel version set in dev mode
  if (version === '0.0.0' || version === '0.0.0-dev') return true;
  // Git-describe format: 1.2.3-14-gabcdef
  if (/\d+-\d+-g[a-f0-9]+$/.test(version)) return true;
  // Explicit NODE_ENV check
  if (process.env.NODE_ENV === 'development') return true;
  return false;
}

// In CLI startup:
if (!isDevBuild(pkg.version)) {
  updateNotifier({ pkg }).notify();
}
```

This is clean, explicit, and requires no special `package.json` configuration.

### 8. The Web UI Problem is Different from the CLI Problem

For a web client showing a status bar version badge, the problem is that:

1. The server reads its version from `package.json` (which is `0.0.0` in dev)
2. The server (or client) checks npm registry and sees `1.2.3` published
3. The UI renders "Upgrade available: 0.0.0 → 1.2.3"

The fix is at the **server level**: the server should expose its version mode (`stable` vs `dev`) via the API (e.g., in `/api/version` or the health endpoint). The client then renders accordingly — showing "Dev" or a "DEV" badge instead of an upgrade prompt when the server reports it is running in dev mode.

### 9. Update Check Privacy: Should Dev Builds Phone Home?

Multiple sources note that update checks in dev mode are unnecessary network traffic and can leak information (e.g., that you're running a dev build of a particular tool, from a particular IP). Best practices from tools like Grafana, GitHub CLI, and Containerlab all skip the network request entirely in dev mode — not just suppress the UI. For DorkOS:

- **Skip the npm registry fetch** in dev mode (not just hide the notification)
- This is faster, more private, and avoids confusion from stale cache entries

---

## Detailed Analysis

### Approach Comparison Matrix

| Approach                                              | Auto-Detects?        | CLI Works | Web UI Works | Testable            | Complexity |
| ----------------------------------------------------- | -------------------- | --------- | ------------ | ------------------- | ---------- |
| `0.0.0-dev` sentinel in package.json + explicit check | Yes (if code checks) | Yes       | Yes          | Yes, via env var    | Low        |
| `NODE_ENV=development` env var check                  | Yes                  | Yes       | Yes          | Yes, toggle env var | Low        |
| Git-describe version (`1.2.3-14-gabcdef`)             | Yes (regex)          | Yes       | Partial      | Medium              | Medium     |
| Build-time injection (inject version at build)        | Yes                  | Yes       | Yes          | Yes, swap at build  | Medium     |
| Config flag (`NO_UPDATE_CHECK=true`)                  | No (manual)          | Yes       | Yes          | Yes                 | Low        |
| VS Code "quality" channel                             | Yes                  | N/A       | Yes          | Medium              | High       |

### Approach 1: Sentinel Version `0.0.0-dev` (Recommended for DorkOS)

**What it is**: Use `"version": "0.0.0-dev"` in `package.json` for all non-CLI packages (client, server), and use `"version": "0.0.0"` for the CLI's `package.json` during development. Add explicit `isDevBuild()` detection in both the CLI and server.

**Pros**:

- The version string itself is self-documenting — any developer reading `0.0.0-dev` instantly knows this is a dev build
- Works across CLI and web UI with a single source of truth
- `0.0.0-dev` is lower than any published version per semver, which is semantically correct
- Easy to test: set `VERSION_OVERRIDE=1.2.3` to simulate an installed user

**Cons**:

- Still needs explicit code to detect and skip update check (semver comparison won't help alone)
- Doesn't show the actual git SHA, losing some dev traceability

**How to implement**:

1. In `apps/server/src/routes/version.ts` (or wherever version is exposed), add dev mode detection
2. In the CLI's startup, guard `updateNotifier` call
3. In the client, render a "DEV" badge when server reports dev mode

### Approach 2: `NODE_ENV` Detection

**What it is**: Detect dev mode via `process.env.NODE_ENV === 'development'` or a custom `DORKOS_DEV_MODE` env var.

**Pros**:

- Uses existing convention already established in the project
- `NODE_ENV` is already set to `development` during `pnpm dev`

**Cons**:

- `NODE_ENV` is not universally reliable (Vite sets it differently from Express)
- Doesn't appear in the version string itself — the UI still shows `0.0.0` which is confusing
- Environment variable discipline is required (see `research/20260225_env_var_discipline.md`)

### Approach 3: Build-Time Version Injection

**What it is**: At build time (for production builds), inject the version from `package.json` into the binary/bundle. In dev (unbundled/unbuilt), have the code fall back to a dev sentinel.

**Pros**:

- Used by containerlab, GitHub CLI (Go), and many Node.js CLIs
- Clean separation: built artifacts have real versions, source runs have dev versions
- DorkOS's CLI already does this via esbuild `define` for `__CLI_VERSION__`

**Cons**:

- Currently only implemented for the CLI, not the server/web client
- Requires build pipeline changes to extend to all packages

**How DorkOS already works**: The CLI's `packages/cli/scripts/build.ts` reads from `package.json` and injects `__CLI_VERSION__` at build time. This is correct and already production-ready for the CLI.

### Testability: How to Test the Upgrade Path Without False Positives

The core tension in dev-mode version handling is: "if we always suppress the upgrade notification in dev, how do we know the feature actually works?"

Best practices from CLI tools:

1. **Environment variable override**: `DORKOS_VERSION_OVERRIDE=1.2.3` or `DORKOS_LATEST_VERSION=2.0.0` env vars that inject specific values for testing
2. **`--check-updates` flag**: An explicit command that forces a version check regardless of dev mode (for manual QA)
3. **Test env var already handled**: `update-notifier` already skips checks when `NODE_ENV=test`, so unit tests won't trigger false positives
4. **Integration test flag**: A `DORKOS_FORCE_UPDATE_CHECK=true` env var that bypasses dev mode detection for integration tests specifically

### Version Display UX: What "World Class" Looks Like

Based on analysis of Raycast, Linear, VS Code, and Figma:

**Status bar / footer**:

- Show version prominently but small: `v1.2.3` in muted text
- In dev mode: Show `DEV` or `v0.0.0-dev` badge (styled differently — amber/orange to signal "not production")
- On hover: tooltip showing git SHA, build date if available

**Upgrade available state** (production only):

- Small indicator: a colored dot or `↑` glyph next to the version
- On click: popover with current → latest, "Release notes" link, one-click update command
- Once dismissed for a version: never show again for that version

**Dev mode badge UX** (recommended for DorkOS):

```
[DEV] v0.0.0-dev  ← amber badge, no upgrade indicator
```

vs production:

```
v1.2.3 ↑  ← muted version + upgrade dot when available
```

The `DEV` badge communicates "this is intentional, you are a developer running from source" rather than "something is broken."

### Privacy Consideration: Skip the Network Request in Dev Mode

When running from source, the server should **not** make the npm registry request at all, not just suppress the UI. Reasons:

- Network request is unnecessary waste (adds latency to startup)
- Dev builds may run in air-gapped environments
- Avoids filling npm's access logs with dev-mode traffic from your own machine
- Avoids stale cache entries polluting real update checks

This means the logic should be: `if (isDevBuild) { return; }` before the `fetch('https://registry.npmjs.org/dorkos')` call.

---

## Recommendation for DorkOS

### Recommended Approach: Layered Dev Detection

Implement three layers of protection, any of which independently suppresses the update check:

**Layer 1 — Sentinel version** (lowest effort, highest signal):

- Set `"version": "0.0.0-dev"` in `apps/server/package.json` and `apps/client/package.json` (already `0.0.0`, add `-dev` suffix)
- The CLI's `packages/cli/package.json` keeps real published versions

**Layer 2 — Explicit code guard** (reliable):

```typescript
// packages/cli/src/index.ts
import updateNotifier from 'update-notifier';
import pkg from '../package.json' assert { type: 'json' };

const isDevBuild =
  pkg.version === '0.0.0' ||
  pkg.version.startsWith('0.0.0-') ||
  process.env.NODE_ENV === 'development';

if (!isDevBuild) {
  updateNotifier({ pkg }).notify();
}
```

**Layer 3 — Server API communicates dev mode** (for web UI):

```typescript
// apps/server/src/routes/version.ts (or health endpoint)
const DEV_VERSION_PATTERN = /^0\.0\.0/;

export function getVersionInfo() {
  const version = pkg.version;
  const isDevMode = DEV_VERSION_PATTERN.test(version) || process.env.NODE_ENV === 'development';

  return {
    version,
    isDevMode,
    // Only fetch latest if not in dev mode
    latestVersion: isDevMode ? null : await fetchLatestFromRegistry(),
  };
}
```

**Client renders accordingly**:

- If `isDevMode: true` → show `DEV` badge, no upgrade prompt
- If `isDevMode: false` and `latestVersion > version` → show upgrade indicator
- If `isDevMode: false` and on latest → show version cleanly, no noise

### Testing the Upgrade Path

To test that the upgrade notification actually works:

```bash
# Test upgrade notification in CLI
DORKOS_VERSION_OVERRIDE=0.0.1 dorkos --help  # Forces version check with a "low" version

# Or temporarily set NODE_ENV to not-development
NODE_ENV=production pnpm dev  # Not recommended for real use, but works for testing
```

Add an explicit test:

```typescript
it('shows upgrade notification when newer version exists', async () => {
  // Mock the registry response
  vi.mock('update-notifier', () => ({ default: mockNotifier }));
  // Set version to a low non-dev version
  process.env.DORKOS_TEST_VERSION = '0.1.0';
  // Assert notification renders
});
```

---

## What Existing DorkOS Research Covers vs. This Report

This report is **additive** to two prior reports:

1. `research/20260227_update_notification_ux_patterns.md` — Covers **where and how** to display update notifications (passive vs. active, progressive disclosure, per-app analysis). Does not address dev mode.

2. `research/20260217_cli_self_update_patterns.md` — Covers **whether to implement self-update** (update-notifier vs. self-update command). Does not address dev mode.

This report covers: **whether to show** the notification at all when in dev mode, and **what version to display** in the status bar.

---

## Sources & Evidence

- **update-notifier skip conditions**: confirmed by fetching `update-notifier/update-notifier.js` source directly — skip conditions are `NO_UPDATE_NOTIFIER`, `NODE_ENV=test`, `--no-update-notifier`, CI detection, config optOut, and interval check. No `0.0.0` detection.
- **GitHub CLI dev build handling**: fetched `cli/cli/internal/update/update.go` — git-describe regex pattern `\d+-\d+-g[a-f0-9]{8}$` for dev detection; env var list `GH_NO_UPDATE_NOTIFIER`, `CODESPACES`, `CI`, `BUILD_NUMBER`, `RUN_ID`
- **Containerlab version management**: [DeepWiki - Containerlab Version Management](https://deepwiki.com/srl-labs/containerlab/7.8-version-management-and-upgrade-system) — `Version=0.0.0` + `COMMIT_HASH` in Makefile; `CLAB_VERSION_CHECK=disable` env var
- **Grafana update check config**: [Configure Grafana](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/) — `[updates] check_update_grafana_com = false`; [GitHub Issue #52888](https://github.com/grafana/grafana/issues/52888) — `hide_version` config discussion
- **Semver prerelease behavior**: [semver.org](https://semver.org/) — prerelease has lower precedence than release; [npm semver package](https://www.npmjs.com/package/semver) — `semver.gt('1.2.3', '0.0.0-dev') === true`
- **Homebrew HEAD behavior**: `brew upgrade` skips HEAD installs unless `--fetch-head` is passed; [Homebrew FAQ](https://docs.brew.sh/FAQ) — HEAD versions are not tracked for upgrade notifications by default
- **Astro dev toolbar**: [Astro docs](https://docs.astro.build/en/guides/dev-toolbar/) — dev toolbar appears only in development, never in production build. A clean model for dev-only UI surfaces.
- **Apache Superset 0.0.0-dev discussion**: [GitHub Discussion #30267](https://github.com/apache/superset/discussions/30267) — `0.0.0-dev` appearing in non-dev context is a known confusion vector when build configuration is incorrect; confirms that `0.0.0-dev` is a recognizable sentinel

---

## Research Gaps & Limitations

- Did not audit VS Code's full update service implementation (the relevant source files returned 404/429 during this session). The behavior is inferred from public documentation and issue tracker analysis.
- Grafana's exact source-code implementation for dev-build detection was not directly inspected.
- Did not research how `simple-update-notifier` (the CJS fork of `update-notifier`) handles these conditions — relevant if DorkOS migrates to CJS for compatibility.
- The web client's current version display implementation in DorkOS was not inspected in detail during this research.

---

## Contradictions & Disputes

- **`0.0.0` vs `0.0.0-dev`**: There is no community consensus. Containerlab uses plain `0.0.0` + separate commit hash. Superset uses `0.0.0-dev`. Both are valid; `0.0.0-dev` is more self-documenting in the version string itself.
- **Skip the request vs. skip the UI**: Some approaches (Grafana config option) only suppress the UI notification while still making the network request. The better practice (GitHub CLI, Containerlab) is to skip the request entirely. This is the recommended approach for DorkOS.
- **`NODE_ENV` reliability**: Vite and Express disagree on when `NODE_ENV=development` is set. Using `NODE_ENV` alone as the sole detection mechanism is fragile. Combining it with a version string pattern check is more reliable.

---

## Search Methodology

- Searches performed: 18
- Most productive search terms: `"update-notifier" skip conditions prerelease`, `VS Code source build dev quality commit`, `github CLI update.go dev build`, `containerlab version management 0.0.0 source`, `Grafana check_update_grafana_com development`
- Primary information sources: GitHub source code (update-notifier, GitHub CLI, Containerlab), Grafana documentation, Astro documentation, semver.org, DeepWiki
- Research depth: Deep

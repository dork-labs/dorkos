---
slug: dev-version-display-upgrade-ux
number: 110
created: 2026-03-10
status: ideation
---

# Dev Version Display & Upgrade UX Overhaul

**Slug:** dev-version-display-upgrade-ux
**Author:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/dev-version-display-upgrade-ux

---

## 1) Intent & Assumptions

- **Task brief:** In dev mode (`pnpm dev`), the server always reports version `0.0.0` because `__CLI_VERSION__` is undefined (only injected by esbuild during CLI builds). The fallback reads `apps/server/package.json` which has `"version": "0.0.0"`. This causes `VersionItem` to always show "Upgrade available" in dev, which is noisy and incorrect. Beyond fixing this bug, the user wants a full UX overhaul of version display and upgrade notifications.

- **Assumptions:**
  - The published CLI version in `packages/cli/package.json` (currently `0.9.0`) is the only "real" version
  - `apps/server/package.json` and `apps/client/package.json` versions (`0.0.0`) are placeholders and will never be published independently
  - The existing upgrade popover UX (copy update command, release notes link) is a good foundation but can be improved
  - `DORKOS_VERSION` already exists in `turbo.json` `globalPassThroughEnv` but is unused

- **Out of scope:**
  - Changes to the release/publishing pipeline itself
  - Self-update mechanism (CLI already uses `update-notifier` pattern)
  - CLI-side update notification (separate from web UI, already functional)

---

## 2) Pre-reading Log

- `apps/server/package.json`: Version is `0.0.0` — this is the dev fallback that causes the bug
- `apps/server/src/lib/version.ts`: Central version resolver. Uses `__CLI_VERSION__` (esbuild-injected) in production, falls back to `package.json` in dev. 14 lines, clean logic
- `apps/server/src/services/core/update-checker.ts`: Fetches `https://registry.npmjs.org/dorkos/latest` with 1-hour in-memory cache, 5-second timeout. Returns stale cache on error. No dev-mode guard
- `apps/server/src/routes/config.ts`: `GET /api/config` returns `{ version: SERVER_VERSION, latestVersion: await getLatestVersion(), ... }`. No dev-mode awareness
- `apps/server/src/env.ts`: Defines optional `DORKOS_VERSION` env var (line 15) but it's unused in version resolution
- `packages/cli/scripts/build.ts`: esbuild injects `__CLI_VERSION__` from `packages/cli/package.json` at build time (lines 14, 49, 96). Only runs during `pnpm build`, not `pnpm dev`
- `packages/cli/src/cli.ts`: CLI entry point. Sets `NODE_ENV=production` (line 137). Displays `DorkOS v${__CLI_VERSION__}` banner
- `packages/cli/src/update-check.ts`: File-cached (24h TTL) npm registry check for CLI. Fire-and-forget from `cli.ts` line 301
- `apps/client/src/layers/features/status/ui/StatusLine.tsx`: Fetches `serverConfig` via TanStack Query (5-min stale time), passes `version` and `latestVersion` to `VersionItem`
- `apps/client/src/layers/features/status/ui/VersionItem.tsx`: Presentational component with `isNewer()` and `isFeatureUpdate()` helpers. Shows amber dot + "Upgrade available" for feature updates, "v{latest} available" for patches
- `apps/client/src/layers/features/status/__tests__/VersionItem.test.tsx`: 185 lines, comprehensive test suite but no test for dev scenario (0.0.0 version)
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx`: Shows version in settings panel (separate from status bar)
- `packages/shared/src/schemas.ts`: Contains `latestVersion` in config schema
- `turbo.json`: `DORKOS_VERSION` in `globalPassThroughEnv` (line 14) — available but unused
- `research/versioning-and-release-system.md`: Prior research noting `0.0.0` in server/client package.json as intentional placeholders
- `research/20260217_cli_self_update_patterns.md`: Covers self-update vs notification approaches
- `research/20260310_dev_version_display_upgrade_ux.md`: New research for this ideation — covers update-notifier internals, GitHub CLI/Containerlab/Grafana/VS Code patterns

---

## 3) Codebase Map

**Primary components/modules:**
- `apps/server/src/lib/version.ts` — Version resolution (dev fallback is the bug)
- `apps/server/src/services/core/update-checker.ts` — npm registry fetch (needs dev guard)
- `apps/server/src/routes/config.ts` — API endpoint exposing version info
- `apps/client/src/layers/features/status/ui/VersionItem.tsx` — Status bar version badge
- `apps/client/src/layers/features/status/ui/StatusLine.tsx` — Status bar container
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx` — Settings version display

**Shared dependencies:**
- `packages/shared/src/schemas.ts` — Config response schema (needs `isDevMode` field)
- `packages/shared/src/transport.ts` — Transport interface (`getConfig()`)
- `apps/server/src/env.ts` — `DORKOS_VERSION` env var definition
- `turbo.json` — `DORKOS_VERSION` passthrough

**Data flow:**
```
[Dev mode]
tsx watch → version.ts (__CLI_VERSION__ undefined) → package.json (0.0.0) → config route → client

[Production]
esbuild → __CLI_VERSION__ injected → version.ts → config route → client

[Proposed]
version.ts → isDevBuild() check → config route (isDevMode: true, latestVersion: null) → VersionItem renders DEV badge
```

**Feature flags/config:**
- `DORKOS_VERSION` env var (defined in turbo.json, unused)
- `showStatusBarVersion` Zustand setting (controls visibility)

**Potential blast radius:**
- Direct: `version.ts`, `update-checker.ts`, `config.ts`, `VersionItem.tsx`, `StatusLine.tsx`, `ServerTab.tsx`, `schemas.ts`
- Indirect: `env.ts`, `.env.example`, `turbo.json`
- Tests: `VersionItem.test.tsx` (update), `update-checker.test.ts` (if exists), new tests needed
- Docs: `contributing/configuration.md`, `contributing/api-reference.md`

---

## 4) Root Cause Analysis

- **Repro steps:**
  1. Run `pnpm dev` from the repo root
  2. Open the web client in browser
  3. Look at the status bar — shows "Upgrade available"

- **Observed vs Expected:**
  - Observed: Status bar shows "Upgrade available" with `0.0.0 → 0.9.0`
  - Expected: Status bar should indicate dev mode, not prompt for an upgrade

- **Evidence:**
  - `apps/server/package.json` line 3: `"version": "0.0.0"`
  - `apps/server/src/lib/version.ts` lines 11-14: fallback reads this when `__CLI_VERSION__` is undefined
  - `__CLI_VERSION__` is only defined by esbuild in `packages/cli/scripts/build.ts` — never during `pnpm dev`

- **Root-cause hypotheses:**
  1. **(High confidence)** `version.ts` fallback reads `0.0.0` from `apps/server/package.json` because `__CLI_VERSION__` is undefined in dev. This is the direct cause.
  2. **(Contributing)** `update-checker.ts` has no dev-mode guard — it fetches npm registry unconditionally, returning a real version (`0.9.0`) that `isNewer()` correctly identifies as newer than `0.0.0`.
  3. **(Contributing)** `VersionItem` has no concept of "dev mode" — it only compares version strings.

- **Decision:** All three hypotheses are correct and contribute. The fix requires changes at all three layers: version resolution, update checking, and UI rendering.

---

## 5) Research

Full research report: `research/20260310_dev_version_display_upgrade_ux.md`

**Potential solutions:**

**1. Sentinel version `0.0.0-dev` + explicit `isDevBuild()` guard**
- Used by Containerlab, Apache Superset
- Pros: Self-documenting version string, simple logic
- Cons: Still needs explicit code guard (semver comparison won't auto-suppress)
- Complexity: Low

**2. `NODE_ENV=development` detection only**
- Standard Node.js convention
- Pros: No package.json changes needed
- Cons: `NODE_ENV` is unreliable across tools (Vite vs Express disagreement), doesn't appear in version string
- Complexity: Low

**3. Git-describe version (e.g., `1.2.3-14-gabcdef`)**
- Used by GitHub CLI
- Pros: Rich dev version info with exact commit
- Cons: Requires git at runtime, regex detection needed, heavier
- Complexity: Medium

**4. Build-time injection for all environments**
- Extend esbuild injection to dev mode
- Pros: Single source of truth, DorkOS already does this for CLI
- Cons: Requires build pipeline changes for dev, breaks tsx hot-reload simplicity
- Complexity: Medium-High

**5. Config flag (`NO_UPDATE_CHECK`)**
- Used by Grafana
- Pros: Explicit user control
- Cons: Requires manual opt-out, developers forget
- Complexity: Low

**6. VS Code "quality channel" detection**
- Separate `stable`/`insider`/`dev` channels
- Pros: Most robust for multi-channel distribution
- Cons: Architectural overhead, overkill for current needs
- Complexity: High

**Recommendation:** Approach 1 (sentinel + explicit guard) combined with Approach 2 (NODE_ENV check as secondary signal). This matches the Containerlab/GitHub CLI gold standard while keeping implementation simple.

**Key research insight:** `update-notifier` has **no built-in 0.0.0 exemption** — it will always report an upgrade is available. The `0.0.0-dev` prerelease tag doesn't help either since `semver.gt('1.2.3', '0.0.0-dev')` is `true`. Explicit detection logic is required.

**Privacy consideration:** Dev mode should skip the npm registry fetch entirely, not just suppress the UI. This avoids unnecessary network traffic, is faster, and prevents stale cache entries.

---

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Dev mode UI treatment | DEV badge, no version number | Clean signal that you're running from source. No false upgrade prompts. Follows VS Code/Astro pattern where dev surfaces look intentionally different from production. |
| 2 | Network behavior in dev | Skip npm registry fetch entirely | Don't phone home in dev. Faster, more private, avoids stale cache. GitHub CLI and Containerlab both take this approach. Return `latestVersion: null` from API. |
| 3 | Testability mechanism | `DORKOS_VERSION_OVERRIDE` env var | When set, bypasses dev detection and uses the override value as the "current version". Enables manual QA of upgrade flow. Already have `DORKOS_VERSION` in turbo.json passthrough. Must be documented in `.env.example` and dev guides. |
| 4 | Scope | Full UX overhaul of version display | Beyond fixing the dev bug, rethink the entire version display: settings page version section, changelog integration, dismiss/snooze for upgrade notifications. |

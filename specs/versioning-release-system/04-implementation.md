# Implementation Summary: Versioning, Release & Update System

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Spec:** specs/versioning-release-system/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 12 / 12

## Tasks Completed

### Session 1 - 2026-02-16

- **Task #1**: Created `VERSION` file at repo root with content `0.1.0`
- **Task #2**: Created annotated git tag `v0.1.0` on commit `2d2f064` (correlating with npm publish date)
- **Task #3**: Created `packages/cli/src/update-check.ts` — npm registry check with file-based cache (24h TTL, 3s timeout)
- **Task #5**: Created `packages/cli/src/__tests__/update-check.test.ts` — 15 tests (6 for isNewer, 9 for checkForUpdate), all passing
- **Task #6**: Created `apps/server/src/services/update-checker.ts` — server-side npm registry check with in-memory cache (1h TTL, 5s timeout, stale-on-error)
- **Task #10**: Created `apps/server/src/services/__tests__/update-checker.test.ts` — 6 tests covering fetch, cache hit, TTL expiry, stale cache on failure, null on never-fetched failure, non-ok response
- **Task #12**: Rewrote `.claude/commands/system/release.md` — 681-line 6-phase release orchestrator with VERSION file source, npm publish, GitHub Release, correct dork-labs/dorkos URLs

### Session 2 - 2026-02-16

- **Task #4**: Modified `packages/cli/src/cli.ts` — added startup banner (version, local URL, network URL) after server start + fire-and-forget update check with boxed notification
- **Task #7**: Modified `packages/shared/src/schemas.ts` (added `latestVersion: z.string().nullable()`), `apps/server/src/routes/config.ts` (returns latestVersion), `apps/server/src/routes/health.ts` (fixed version source to use `__CLI_VERSION__`), `packages/cli/scripts/build.ts` (added `define` for server bundle)
- **Task #8**: Created `apps/client/src/layers/features/status/ui/VersionItem.tsx` — version badge with update indicator + tooltip. Added `showStatusBarVersion` toggle to app-store. Integrated into StatusLine as last entry.
- **Task #9**: Modified `apps/client/src/layers/features/settings/ui/ServerTab.tsx` — added amber update notice after version row. Also fixed `direct-transport.ts` to include `latestVersion: null`.

## Files Modified/Created

**Source files:**

- `VERSION` (new) — plain text `0.1.0`
- `packages/cli/src/update-check.ts` (new) — `checkForUpdate()`, `isNewer()`
- `packages/cli/src/cli.ts` (modified) — startup banner + update notification
- `packages/shared/src/schemas.ts` (modified) — added `latestVersion` to ServerConfigSchema
- `apps/server/src/services/update-checker.ts` (new) — `getLatestVersion()`, `resetCache()`
- `apps/server/src/routes/config.ts` (modified) — returns latestVersion, fixed version source
- `apps/server/src/routes/health.ts` (modified) — fixed version to use `__CLI_VERSION__`
- `packages/cli/scripts/build.ts` (modified) — added `__CLI_VERSION__` define for server bundle
- `apps/client/src/layers/features/status/ui/VersionItem.tsx` (new) — version badge component
- `apps/client/src/layers/features/status/ui/StatusLine.tsx` (modified) — integrated VersionItem
- `apps/client/src/layers/features/status/index.ts` (modified) — export VersionItem
- `apps/client/src/layers/shared/model/app-store.ts` (modified) — added `showStatusBarVersion` toggle
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx` (modified) — update notice row
- `apps/client/src/layers/shared/lib/direct-transport.ts` (modified) — added `latestVersion: null`
- `.claude/commands/system/release.md` (rewritten) — 6-phase release orchestrator

**Test files:**

- `packages/cli/src/__tests__/update-check.test.ts` (new) — 15 tests, all passing
- `apps/server/src/services/__tests__/update-checker.test.ts` (new) — 6 tests, all passing
- `apps/client/src/layers/features/status/__tests__/VersionItem.test.tsx` (new) — 19 tests, all passing

**Git:**

- Annotated tag `v0.1.0` on commit `2d2f064` (not yet pushed)

## Known Issues

- Pre-existing TypeScript errors in CLI package (`check-claude.test.ts` types, `cli.ts` dynamic imports) — unrelated to this spec
- Git tag `v0.1.0` created locally but not pushed (requires user confirmation)

## Implementation Notes

### Session 1

- Tasks #3 and #5 implemented together by a single agent (update-check.ts + tests)
- Tasks #6 and #10 implemented together by a single agent (update-checker.ts + tests)
- TypeScript PostToolUse hook gives false positives — verified with `npx tsc --noEmit` (exit 0)

### Session 2

- Resumed from context compaction
- Batch 3: Tasks #4, #7 (parallel) — CLI banner + schema/route changes
- Batch 4: Tasks #8, #9 (parallel) — VersionItem component + ServerTab update notice
- Batch 5: Task #11 — VersionItem tests (19 tests)
- Task #9 agent also fixed `direct-transport.ts` to include `latestVersion: null` for Obsidian compatibility
- All TypeScript compiles clean (client exit 0, server exit 0)
- All 248 server tests + 19 VersionItem tests + 15 update-check tests passing

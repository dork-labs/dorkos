# Implementation Summary: Marketplace 02: Install

**Created:** 2026-04-06
**Last Updated:** 2026-04-06
**Spec:** specs/marketplace-02-install/02-specification.md

## Progress

**Status:** In Progress — Batches 1–3 complete and verified; ready to resume at Batch 4
**Tasks Completed:** 16 / 31 (Batches 1, 2, 3)
**Verification:** typecheck clean, full server suite **2107 / 2107 tests passing** (108 marketplace + 1999 pre-existing), lint clean

## Tasks Completed

### Session 1 - 2026-04-06

**Batch 1** (1/1 ✓):

- Task #1: [P1] Create marketplace service module skeleton and shared types

**Batch 2** (7/7 ✓ — holistic gate: typecheck clean, 65 tests passing, eslint clean):

- Task #2: [P1] Implement marketplace-source-manager with marketplaces.json CRUD (9 tests)
- Task #3: [P1] Implement marketplace-cache with TTL and content-addressable storage (17 tests)
- Task #6: [P2] Implement permission-preview builder (11 tests; conflicts wiring TODO for #8)
- Task #7: [P2] Implement conflict-detector for slot/skill/task/cron/adapter collisions (9 tests; widened `ConflictReport.type` union to add `'package-name'`)
- Task #9: [P3] Implement transaction engine with stage/activate/rollback (8 tests)
- Task #17: [P5] Implement telemetry hook with no-op default reporter (4 tests)
- Task #24: [P8] Build fixture packages for end-to-end install tests (7 fixtures + sanity test)

**Batch 3** (8/8 files-on-disk; functional state degraded by env issue — see Known Issues):

- Task #4: [P1] Implement package-resolver for name@source resolution (13 tests, all passing)
- Task #5: [P1] Wire template-downloader integration for marketplace clones (6 tests passing in isolation; **runtime broken** because additive `TemplateDownloader` interface + `cloneRepository` function in `apps/server/src/services/core/template-downloader.ts` keep being reverted)
- Task #8: [P2] Wire conflict-detector into permission-preview builder (permission-preview test count grew from 11 to 13)
- Task #10: [P4] Implement plugin install flow (5 tests passing)
- Task #11: [P4] Implement agent install flow (4 tests passing in isolation; **runtime broken** because additive `skipTemplateDownload` field on `CreateAgentOptionsSchema` in `packages/shared/src/mesh-schemas.ts` and the conditional in `apps/server/src/services/core/agent-creator.ts` keep being reverted — install-agent.test.ts mocks `createAgentWorkspace` so the runtime bug is masked at the test layer)
- Task #12: [P4] Implement skill-pack install flow (4 tests passing)
- Task #13: [P4] Implement adapter install flow (3 tests passing)
- Task #14: [P4] Implement uninstall flow with --purge support (6 tests passing)

**Batch 3 verification snapshot** (last run while edits were on disk): typecheck clean, 108 tests passing across 14 marketplace test files.

## Files Modified/Created

**Source files:**

- `apps/server/src/services/marketplace/types.ts` (modified by #7 — widened `ConflictReport.type` union to include `'package-name'`)
- `apps/server/src/services/marketplace/marketplace-source-manager.ts` (#2 — 200 lines)
- `apps/server/src/services/marketplace/marketplace-cache.ts` (#3 — 302 lines)
- `apps/server/src/services/marketplace/permission-preview.ts` (#6 — 370 lines, exports `ConflictDetectorLike` forward-declared interface)
- `apps/server/src/services/marketplace/conflict-detector.ts` (#7 — 405 lines, AdapterManager API is `listAdapters()`)
- `apps/server/src/services/marketplace/transaction.ts` (#9 — staging+rollback primitive)
- `apps/server/src/services/marketplace/telemetry-hook.ts` (#17 — module-level singleton reporter)
- `apps/server/src/services/marketplace/fixtures/{valid-plugin,valid-agent,valid-skill-pack,valid-adapter,broken/...}` (#24)
- `apps/server/src/services/marketplace/fixtures/README.md` (#24)
- `apps/server/package.json` (#1 — added `@dorkos/marketplace: workspace:*`)
- `pnpm-lock.yaml`

**Test files:**

- `apps/server/src/services/marketplace/__tests__/marketplace-source-manager.test.ts` (9)
- `apps/server/src/services/marketplace/__tests__/marketplace-cache.test.ts` (17)
- `apps/server/src/services/marketplace/__tests__/permission-preview.test.ts` (11)
- `apps/server/src/services/marketplace/__tests__/conflict-detector.test.ts` (9)
- `apps/server/src/services/marketplace/__tests__/transaction.test.ts` (8)
- `apps/server/src/services/marketplace/__tests__/telemetry-hook.test.ts` (4)
- `apps/server/src/services/marketplace/__tests__/fixtures.test.ts` (7)

**Total: 65 tests across the marketplace service domain, all passing.**

## Known Issues

- **Permission-preview wiring deferred**: ~~`permission-preview.ts` has `preview.conflicts = []; // TODO: wired up in task 2.3`.~~ Resolved by Batch 3 task #8.
- **AdapterManager API note**: The real method is `listAdapters()` returning `Array<{ config: AdapterConfig; status }>`, not `list()` as some spec snippets show. Tasks #13 and #14 match this real shape.

### Session 1 blocker — RESOLVED

**Root cause:** the transaction engine (`services/marketplace/transaction.ts`) was running real `git reset --hard` against the live worktree from inside install-flow failure-path tests. Each `git reset --hard` blew away every uncommitted tracked-file change (including the additive edits to `template-downloader.ts`, `mesh-schemas.ts`, `agent-creator.ts`, and `apps/server/package.json`) while leaving untracked files (the new `services/marketplace/` directory) intact. This perfectly explained why new files survived but additive edits to tracked files kept disappearing.

**Diagnosis evidence:**

- Reflog showed ~30 `git reset` operations during marketplace test runs, all to `dorkos-rollback-install-{plugin,agent,skill-pack}-*` branches
- 68 orphaned `dorkos-rollback-*` branches accumulated in the repo from prior runs
- `transaction.ts:190` invokes `execFileAsync('git', ['reset', '--hard', branch], { cwd, ... })` against `process.cwd()` which is the actual worktree
- The 3 install flows that pass `rollbackBranch: true` (`install-plugin.ts`, `install-agent.ts`, `install-skill-pack.ts`) DO trigger this code path; `install-adapter.ts` correctly uses `rollbackBranch: false`
- A long-running `pnpm dev` / `turbo dev` watcher also raced on the same `.git` directory, explaining intermittent `index.lock` errors

**Fix applied:**

1. Stopped the `pnpm dev` background watcher (manually by user)
2. Deleted all 68 orphaned `dorkos-rollback-*` branches
3. Added `vi.spyOn(transactionInternal, 'isGitRepo').mockResolvedValue(false)` in `beforeEach` of `install-plugin.test.ts`, `install-agent.test.ts`, `install-skill-pack.test.ts` — prevents the real backup-branch and git-reset code paths from firing during test runs
4. Re-applied the 3 additive edits (now persistent)
5. Re-added `@dorkos/marketplace: workspace:*` to `apps/server/package.json` and refreshed `pnpm-lock.yaml`
6. Rebuilt `better-sqlite3` against current Node 24 (the `pnpm install` had introduced a NODE_MODULE_VERSION mismatch, unrelated to the marketplace work but surfaced when running the full server suite)
7. Updated one pre-existing test (`agents-creation.test.ts`) to match the new recursive `.dork/` mkdir signature

**Final verification:**

- `pnpm typecheck` (apps/server) — clean
- `pnpm vitest run` (apps/server) — **2107 / 2107 tests passing across 131 files**
- `pnpm lint` (apps/server) — clean (1 pre-existing warning in `routes/config.ts`, unrelated)
- `pnpm typecheck` + `pnpm lint` (packages/shared) — clean
- 0 orphan rollback branches

**Lesson for follow-up specs:** any tests that exercise `runTransaction({ rollbackBranch: true })` MUST mock `transactionInternal.isGitRepo` to return false, OR the transaction tests should be redesigned to use an isolated temp git repo. The current `transaction.ts` design will silently destroy uncommitted tracked-file work whenever a failure-path test runs in the live worktree.

## Implementation Notes

### Session 1

**Review approach:** Holistic batch-level verification gates (typecheck + targeted vitest + eslint on touched directories) rather than per-task two-stage review. This 31-task spec across 9 phases is exactly the case the stored feedback `feedback_holistic_batch_gates.md` was written for. Spot-checks reserved for load-bearing wiring tasks (e.g., #20 server wiring, #16 orchestrator, #25/#26 integration tests).

_(Implementation in progress)_

# Implementation Summary: Floating picture-in-picture panel for the cockpit

**Created:** 2026-07-11
**Last Updated:** 2026-07-11
**Spec:** specs/pip-panel/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 3 / 7

## Session

- **Worktree:** `/Users/doriancollier/.dork/workspaces/dorkos/dor-296-pip-panel` (branch `dor-296-pip-panel`, ports 4296/4446)
- **Orchestration:** named implementation agents (Sonnet/Opus), batch-level commits by the orchestrator, holistic REVIEW.md review before PR (operator's batch-gate preference; per-task two-stage review skipped by standing directive).

## Tasks Completed

### Session 1 - 2026-07-11

- Task #1.1: Build the floating-panel primitive (drag, resize, clamp, chrome, a11y) — Petra/Opus, DONE (13 tests)
- Task #1.2: Add the PIP state slice with persisted geometry — Sable/Sonnet, DONE (7 tests; app-store suite 69/69 green)
- Task #2.1: Build the PipHost content-routing feature — Hollis/Opus, DONE (6 tests; batch-1 regression green; node-identity remount test instead of mount-spy, deliberate)

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/shared/ui/floating-panel.tsx` (new)
- `apps/client/src/layers/shared/ui/index.ts` (barrel export)
- `apps/client/src/layers/shared/model/app-store/app-store-pip.ts` (new)
- `apps/client/src/layers/shared/lib/constants.ts` (STORAGE_KEYS.PIP_PANEL_STATE)
- `apps/client/src/layers/shared/model/app-store/app-store-helpers.ts` (readPipGeometry/writePipGeometry)
- `apps/client/src/layers/shared/model/app-store/app-store-types.ts` (AppState + PipSlice)
- `apps/client/src/layers/shared/model/app-store/app-store.ts` (composition + resetPreferences wipe)
- `apps/client/src/layers/shared/model/index.ts` (PipContent barrel export)
- `apps/client/src/layers/shared/model/app-store/index.ts` (PipSlice/PipContent re-export)

**Test files:**

- `apps/client/src/layers/shared/ui/__tests__/floating-panel.test.tsx` (new, 13 tests)
- `apps/client/src/layers/shared/model/app-store/__tests__/app-store-pip.test.ts` (new, 7 tests)

## Known Issues

_(None yet)_

## Implementation Notes

### Session 1

Batches (from 03-tasks.json dependencies — analysis agent skipped, plan is trivially derivable; assumption logged):

- Batch 1: 1.1 (primitive), 1.2 (state slice) — parallel, disjoint files
- Batch 2: 2.1 (PipHost)
- Batch 3: 2.2 (shell mounts + route test), 3.1 (playground), 3.2 (changelog) — parallel, disjoint files
- Batch 4: 3.3 (a11y/token pass + full verify)

# Implementation Summary: Floating picture-in-picture panel for the cockpit

**Created:** 2026-07-11
**Last Updated:** 2026-07-11
**Spec:** specs/pip-panel/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 7 / 7

## Session

- **Worktree:** `/Users/doriancollier/.dork/workspaces/dorkos/dor-296-pip-panel` (branch `dor-296-pip-panel`, ports 4296/4446)
- **Orchestration:** named implementation agents (Sonnet/Opus), batch-level commits by the orchestrator, holistic REVIEW.md review before PR (operator's batch-gate preference; per-task two-stage review skipped by standing directive).

## Tasks Completed

### Session 1 - 2026-07-11

- Task #1.1: Build the floating-panel primitive (drag, resize, clamp, chrome, a11y) — Petra/Opus, DONE (13 tests)
- Task #1.2: Add the PIP state slice with persisted geometry — Sable/Sonnet, DONE (7 tests; app-store suite 69/69 green)
- Task #2.1: Build the PipHost content-routing feature — Hollis/Opus, DONE (6 tests; batch-1 regression green; node-identity remount test instead of mount-spy, deliberate)
- Task #2.2: Mount PipHost in both shells + route-persistence test — Mona/Sonnet, DONE (same-DOM-node assertion across rerender; app-shell-slots mock extended with PIP fields — required, PipHost is now real in AppShell)
- Task #3.1: Dev Playground showcase — Pia/Sonnet, DONE (one FloatingPanel section: open A/B replace proof + close; manual browser check deferred to batch 4)
- Task #3.2: Changelog fragment — Chip/Sonnet, DONE (deleted 2 auto-stubs, wrote 260711-154357-pip-panel-primitive.md)
- Task #3.3: Final a11y + design-token review, full verify — Vera/Opus, DONE (audit clean, zero fixes needed; pnpm verify: 441 files / 4925 tests pass; use-session-submit teardown race is a pre-existing full-run flake, green in isolation)
- Review round: Rex/Opus (code-reviewer, REVIEW.md) — verdict ready-to-merge, 4 polish nits; all applied by Hollis/Opus (exit animation via always-mounted AnimatePresence, stable dock geometry identity, mount-count renderer test, gesture abort on unmount) — 38 tests green after fixes
- Live browser pass (orchestrator, Playwright): default dock exact, replace-on-open single instance, Escape survives, drag commits once + persists exact geometry, reload restores position, mobile guard closes below 768px, zero new console errors

## Known Issues

- Keyboard drag/resize gap: panel move/resize is pointer-only in v1 (close/restore fully keyboard-reachable). Intentional scope decision (spec D8/task 3.3); revisit if review asks.

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

## Implementation Notes

### Session 1

Batches (from 03-tasks.json dependencies — analysis agent skipped, plan is trivially derivable; assumption logged):

- Batch 1: 1.1 (primitive), 1.2 (state slice) — parallel, disjoint files
- Batch 2: 2.1 (PipHost)
- Batch 3: 2.2 (shell mounts + route test), 3.1 (playground), 3.2 (changelog) — parallel, disjoint files
- Batch 4: 3.3 (a11y/token pass + full verify)

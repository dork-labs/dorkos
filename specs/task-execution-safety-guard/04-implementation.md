# Implementation Summary: Dev/Preview Task-Execution Safety Guard

**Created:** 2026-06-25
**Last Updated:** 2026-06-25
**Spec:** specs/task-execution-safety-guard/02-specification.md
**Tracker:** DOR-149 · **ADR:** 285

## Session

- **Worktree:** `~/.dork/workspaces/dorkos/dor-149-task-execution-safety-guard`
- **Branch:** `dor-149-task-execution-safety-guard` (off `main` @ `fd693d81`)
- **Why isolated:** another session was concurrently writing the shared `main`
  checkout (it added spec #262); one-checkout-one-writer.

## Progress

**Status:** In Progress
**Tasks Completed:** 1 / 3

## Tasks Completed

### Session 1 - 2026-06-25

- Task #1 (1.1): Production gate — `resolveTasksFiring` + decouple subsystem gate
  from the fire decision.

## Files Modified/Created

**Source files:**

- `apps/server/src/services/tasks/resolve-firing.ts` (new) — the pure production-gate function.
- `apps/server/src/services/tasks/task-scheduler-service.ts` — `mayFire`/`firingReason` on
  `SchedulerConfig`; `dispatch()` early-returns when `!mayFire`; `start()` logs the reason.
- `apps/server/src/index.ts` — compute the firing decision via `resolveTasksFiring` and pass
  it into the scheduler config (subsystem gate unchanged, so display still works in dev).

**Test files:**

- `apps/server/src/services/tasks/__tests__/resolve-firing.test.ts` (new) — 10 table-driven cases.
- `apps/server/src/services/tasks/__tests__/task-scheduler-service.test.ts` — new
  `production gate (mayFire)` block (suppress when false / fire when true); configs made explicit.
- `apps/server/src/services/tasks/__tests__/flow-drain-pulse-seat.integration.test.ts` — config made explicit.

## Known Issues

_(None)_

## Implementation Notes

### Session 1

- **Verification (task 1.1 gate):** `pnpm --filter @dorkos/server` — tasks tests 99 passed,
  typecheck exit 0, lint 0 errors (pre-existing `index.ts` max-lines warning only).
- **Build note:** the fresh worktree needs `pnpm turbo build --filter=@dorkos/server^...`
  before vitest (workspace `@dorkos/skills` dist must exist, else `@dorkos/skills/duration`
  fails to resolve — the known stale-shared-dist false-red).
- **Design:** the firing decision is decoupled from the subsystem gate — `index.ts` keeps the
  existing `tasksEnabled` subsystem gate (so tasks list/display wherever configured) and the
  new `mayFire` gates only `dispatch()`. `NODE_ENV==='production'` is today's production
  signal; the `deployEnv` parameter is the forward-compat seam (off-by-default for any future
  named non-production deploy), undefined today.

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

**Status:** Complete
**Tasks Completed:** 3 / 3

## Tasks Completed

### Session 1 - 2026-06-25

- Task #1 (1.1): Production gate — `resolveTasksFiring` + decouple subsystem gate
  from the fire decision.
- Task #2 (2.1): `dorkHome`-keyed leader lock — `scheduler-lock.ts` (pid +
  heartbeat + steal-if-stale) behind a `LeaderLock` seam; `dispatch()` leader gate;
  `start()`/`stop()` acquire/heartbeat/release wiring.
- Task #3 (3.1): Dispatch idempotency — Drizzle `pulse_dispatch_log` table +
  migration `0018` (note: actual next migration number is 0018, not the spec's
  guessed 0003); `TaskStore.tryClaimDispatch` (`INSERT … ON CONFLICT DO NOTHING`)
  - `pruneDispatchLog` (7-day TTL); `dispatch()` claims the croner `currentRun()`
    tick before creating a run. Manual triggers exempt.

## Files Modified/Created

**Source files:**

- `apps/server/src/services/tasks/resolve-firing.ts` (new) — the pure production-gate function.
- `apps/server/src/services/tasks/scheduler-lock.ts` (new) — `LeaderLock` interface +
  `SchedulerLock` (file lock at `<dorkHome>/tasks/scheduler.lock`, pid + heartbeat + steal-if-stale).
- `apps/server/src/services/tasks/task-scheduler-service.ts` — `mayFire`/`firingReason` on
  `SchedulerConfig`; `dorkHome`/`leaderLock` on `SchedulerDeps`; `dispatch()` early-returns when
  `!mayFire` or `!isLeader`; `start()` acquires + heartbeats, `stop()` clears + releases.
- `apps/server/src/index.ts` — compute the firing decision via `resolveTasksFiring`, pass it +
  `dorkHome` into the scheduler config (subsystem gate unchanged, so display still works in dev).

**Test files:**

- `apps/server/src/services/tasks/__tests__/resolve-firing.test.ts` (new) — 10 table-driven cases.
- `apps/server/src/services/tasks/__tests__/scheduler-lock.test.ts` (new) — 7 cases
  (acquire / follower / steal-when-stale / no-steal-when-fresh / release-only-owner /
  heartbeat-advances / follower-promotes).
- `apps/server/src/services/tasks/__tests__/task-scheduler-service.test.ts` — new
  `production gate (mayFire)` + `leader gate` blocks; configs made explicit.
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

### Session 1 — code-review fixes (VERIFY)

A `code-reviewer` pass on the full branch found one Critical correctness bug and
several smaller items; all addressed before merge:

- **Critical — idempotency key:** the original code keyed the dedup row on croner
  `currentRun()`, which (verified against croner@10.0.1) is the **wall-clock fire
  instant at ms precision**, not the scheduled boundary — so two processes firing
  the same occurrence computed different keys and both fired, making Defense 3
  inert for cross-process dedup. Fixed with `scheduledTickKey(cron, firedAt)`,
  which floors the trigger time to the cron's resolution (60s minute/alias, 1s
  6-field) so co-located processes (single-machine lock = one wall clock) agree on
  one key. Spec §Defense-3 and ADR-285 wording reconciled to the real mechanism.
- **Critical — missing regression test:** added the mandated two-leaders-one-DB
  test firing the same minute a few ms apart and asserting exactly one run (fails
  under the old raw-`currentRun()` key — a true guard), plus `scheduledTickKey`
  unit tests.
- **Important — null fallback:** `dispatch()` now always claims when the task has a
  cron (no silent skip), per the spec.
- **Important — leader-lock race:** `tryAcquire` now uses an O_EXCL exclusive
  create for the no-lock case, so a simultaneous no-lock race can never elect two
  leaders (the stale-steal path keeps the verify-after-write).
- **Minor:** guard `start()` against leaking a prior heartbeat interval; validate
  `hostname` in the lock record read; `mkdirSync` moved to the lock constructor.

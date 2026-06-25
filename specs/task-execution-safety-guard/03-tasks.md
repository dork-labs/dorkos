# Tasks — Dev/Preview Task-Execution Safety Guard

**Spec:** [`02-specification.md`](./02-specification.md) · **Slug:** `task-execution-safety-guard` · **Tracker:** DOR-149 · **ADR:** 285 (draft)
**Mode:** full · **Generated:** 2026-06-25

Three independent, individually-shippable phases — one reviewable commit each, behind one spec. All three converge on `task-scheduler-service.ts → dispatch()`, so they run **sequentially** (1.1 → 2.1 → 3.1), not in parallel. Estimate 5 (< xl) → no sub-issue promotion; all tasks stay checklist lines on DOR-149.

## Critical path

```
1.1  Production gate   ──▶  2.1  Leader lock   ──▶  3.1  Idempotency
(headline safety win)      (one process fires)     (at-most-once per tick)
```

## Phase 1 — Production Gate

### Task 1.1: Add `resolveTasksFiring` production gate; decouple subsystem gate from the fire decision

- **New:** `apps/server/src/services/tasks/resolve-firing.ts` — pure
  `resolveTasksFiring({ nodeEnv, explicitOverride, schedulerEnabled, deployEnv? }) → { mayFire, reason }`.
  Explicit `DORKOS_TASKS_ENABLED` override wins both directions; a named non-prod
  `deployEnv` is off (forward-compat seam, undefined today); default is
  `nodeEnv==='production' && schedulerEnabled`.
- **Edit:** `index.ts` keeps the subsystem gate (display/routes survive in dev) but
  computes `mayFire` separately and passes it to the scheduler.
- **Edit:** `task-scheduler-service.ts` — `registerTask()` still registers crons
  (next-run display works); `dispatch()` early-returns when `!mayFire`; log the
  `reason` at `start()`.
- **Tests:** table-driven `resolve-firing.test.ts` (dev→off, prod+enabled→on,
  prod+disabled→off, dev+override→on, prod+override-false→off, preview→off,
  test→off) + scheduler integration (no run when `mayFire=false`, but `getNextRun()`
  non-null).
- **Deps:** none. **Size:** medium.

## Phase 2 — Leader Lock

### Task 2.1: Add a `dorkHome`-keyed leader lock so only one process fires

- **New:** `apps/server/src/services/tasks/scheduler-lock.ts` —
  `<dorkHome>/tasks/scheduler.lock` (`{pid, hostname, startedAt, heartbeatAt}`);
  acquire / heartbeat (10s) / release; steal when `heartbeatAt` older than
  `STALE_TTL_MS` (30s); injected clock for tests.
- **Edit:** `task-scheduler-service.ts` — add `dorkHome` to `SchedulerDeps`;
  acquire in `start()`, heartbeat interval, release in `stop()`; `dispatch()`
  early-returns when `!isLeader` (composes after the `mayFire` gate); followers
  re-attempt acquisition and promote on leader death.
- **Edit:** `index.ts` — pass `dorkHome` (already in scope) into the deps.
- **Tests:** `scheduler-lock.test.ts` (acquire-when-absent, follower-when-fresh,
  steal-when-stale, release-only-when-owner, heartbeat-advances) + scheduler
  integration (two instances on one temp `dorkHome` → only the leader fires).
- **Deps:** 1.1 (shared `dispatch()`). **Size:** medium.

## Phase 3 — Dispatch Idempotency

### Task 3.1: Add `(taskId, scheduledFireTime)` dispatch idempotency via a Drizzle dedup table

- **Edit:** `packages/db/src/schema/tasks.ts` — new `pulse_dispatch_log` table,
  `UNIQUE(task_id, scheduled_fire_time)`. Migration `0003` via
  `pnpm --filter @dorkos/db db:generate`; applied by `runMigrations`.
- **Edit:** `task-store.ts` — `tryClaimDispatch(taskId, fireTime)` (`INSERT … ON
CONFLICT DO NOTHING` → did-insert?) + `pruneDispatchLog(7-day TTL)` in the
  `start()` pruning pass.
- **Edit:** `task-scheduler-service.ts` — callback `(self) => dispatch(task,
self.currentRun())`; `dispatch()` gates on `tryClaimDispatch` after the
  `mayFire` + `isLeader` gates, before `createRun`. Manual triggers exempt.
- **Tests:** first-dispatch-inserts, second-is-noop, different-ticks-both-proceed,
  manual-not-deduped, prune-removes-stale-keeps-fresh + integration (two schedulers
  sharing a tick → exactly one run).
- **Deps:** 2.1 (shared `dispatch()`). **Size:** medium.

## Next stage

**EXECUTE** — `/flow:execute specs/task-execution-safety-guard/02-specification.md` (moves to an isolated worktree).

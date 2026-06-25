---
slug: task-execution-safety-guard
number: 261
created: 2026-06-25
status: specified
linearIssue: DOR-149
---

# Dev/Preview Task-Execution Safety Guard

**Status:** Draft
**Author:** Dorian Collier (via /flow)
**Date:** 2026-06-25
**Tracker:** DOR-149 (P1 · urgent) — project _Tasks — Execution Safety & Skill Unification_
**Ideation:** [`01-ideation.md`](./01-ideation.md) · **Decision:** ADR-D (seeded by this spec)

## Overview

Three independent, defense-in-depth guards that prevent DorkOS scheduled tasks
(Pulse crons) from firing when they must not, and from firing more than once per
scheduled tick. Today any running server fires every enabled cron, and N servers
sharing one `dorkHome` fire N times — so a developer's laptop, or a future
preview deployment, could take **autonomous outward action on real Linear** via
the `/flow` Pulse seat. This spec closes that with: (1) production-gated firing,
(2) a `dorkHome`-keyed leader lock, (3) dispatch idempotency keyed on
`(taskId, scheduledFireTime)`.

## Background / Problem Statement

The firing engine is `apps/server/src/services/tasks/task-scheduler-service.ts`.
`start()` registers a `croner` `Cron` per enabled task; each cron's callback calls
**`dispatch(task)`** (the single firing chokepoint, ~line 252), which — past a
concurrency cap and an enabled/active re-read — unconditionally creates a
`scheduled` run and executes it.

There are three independent gaps:

1. **No real environment gate.** The only enable signal (`index.ts:250`) is
   `tasksEnabled = 'DORKOS_TASKS_ENABLED' in process.env ? env.DORKOS_TASKS_ENABLED
: schedulerConfig.enabled` — config-driven, **not** production-gated. A dev
   server with `scheduler.enabled` in `config.json` fires.
2. **No cross-process coordination.** Each process holds its own in-memory croner
   jobs; N processes sharing `~/.dork` each fire (the Vercel-cron-style multi-fire
   risk).
3. **No fire-time dedup.** `dispatch()` keys on nothing — a manual-vs-scheduled
   race, a lock handoff, or a croner edge can double-fire the same tick.

The `/flow` Pulse seat makes any mis-fire consequential: it claims and transitions
real Linear issues. This is the safety guard for DorkOS's own autonomous loop, and
the urgent (P1) Phase-1 item of the harness-portability roadmap (D1).

## Goals

- A dev server (Vite, `NODE_ENV=development`) **never** fires scheduled tasks by
  default; the installed/built CLI (real `~/.dork`, `NODE_ENV=production`) does.
- **Default OFF for every non-production environment**, including a future hosted
  preview/staging server — without that environment having to remember to opt out.
- Of N processes sharing one `dorkHome`, **at most one** (the leader) fires.
- A given `(taskId, scheduledFireTime)` dispatches **at most once**, even if the
  env-gate and leader lock are both somehow bypassed.
- Dev still **discovers and displays** tasks (list + next-run) even when firing is
  suppressed — visibility is not gated, only firing is.
- All three guards are independently shippable and individually correct.

## Non-Goals

- Cross-host distributed consensus. The lock is scoped to one `dorkHome` on one
  machine (the documented multi-writer hazard), not a multi-node election.
- D2/D3/D4 (DOR-150/151/152): tasks-into-skills unification, `dorkos tasks list`,
  flow-drain-in-plugin. D1 is explicitly independent and must not wait on them.
- Reworking run execution (Relay vs direct), the concurrency cap, retention, or the
  task file format.
- Gating **manual** triggers (`triggerManualRun`) — an explicit human/agent act is
  always allowed and is never deduped against a scheduled fire (see Open Q3).

## Technical Dependencies

- `croner` `^10.0.1` (already a dep) — callback receives the `Cron` instance;
  `self.currentRun(): Date | null` yields the **intended scheduled tick**, the
  idempotency key source. No new dep.
- `@dorkos/db` (Drizzle ORM over `better-sqlite3`) — schema at
  `packages/db/src/schema/tasks.ts`; migrations in `packages/db/drizzle/`
  (`db:generate` = `drizzle-kit generate`); applied by `runMigrations(db)` at
  startup (`apps/server/src/index.ts:74`). The dedup table rides this pattern.
- `apps/server/src/env.ts` — `DORKOS_TASKS_ENABLED` (`boolFlag`, already present)
  and `NODE_ENV` (`development|production|test`).
- `apps/server/src/lib/dork-home.ts` — the lock's home/key (`<dorkHome>/tasks/`).
- **No new external library.** The leader lock is home-rolled (confirmed
  greenfield — no lockfile dep vendored; the existing
  `runtimes/claude-code/sessions/session-lock.ts` is an unrelated in-memory
  client-id lock, referenced only for style).

## Detailed Design

### Defense 1 — Production-gated firing (forward-compatible)

Centralize the firing-authorization decision in **one** pure function so the
future deployment-environment seam is a one-function change:

```ts
// apps/server/src/services/tasks/resolve-firing.ts (new)
/** Resolve whether THIS process/environment is authorized to FIRE scheduled tasks. */
export function resolveTasksFiring(input: {
  nodeEnv: 'development' | 'production' | 'test';
  explicitOverride: boolean | undefined; // DORKOS_TASKS_ENABLED if the key is present, else undefined
  schedulerEnabled: boolean; // configManager scheduler.enabled (master switch)
  deployEnv?: string; // SEAM: future DORKOS_DEPLOY_ENV / platform var; undefined today
}): { mayFire: boolean; reason: string } {
  // 1. Explicit override wins in BOTH directions (force-on in dev, force-off in a prod build).
  if (input.explicitOverride !== undefined) {
    return { mayFire: input.explicitOverride, reason: 'DORKOS_TASKS_ENABLED override' };
  }
  // 2. SEAM (YAGNI today): a named non-production deployment never fires by default.
  //    When a hosted preview/staging server is introduced, set deployEnv and this
  //    branch keeps it OFF without it remembering DORKOS_TASKS_ENABLED=false.
  if (input.deployEnv && input.deployEnv !== 'production') {
    return { mayFire: false, reason: `non-production deployEnv "${input.deployEnv}"` };
  }
  // 3. Default: real production build AND the user's master switch.
  const mayFire = input.nodeEnv === 'production' && input.schedulerEnabled;
  return { mayFire, reason: `nodeEnv=${input.nodeEnv} schedulerEnabled=${input.schedulerEnabled}` };
}
```

- **`explicitOverride`** is `'DORKOS_TASKS_ENABLED' in process.env ?
env.DORKOS_TASKS_ENABLED : undefined` — the presence check distinguishes "unset"
  from "false" (the existing comment at `index.ts:251` already does this).
- **Today** `deployEnv` is always `undefined`, so non-production = `development` /
  `test` → off; `production` (the installed CLI) → on (honoring `scheduler.enabled`).
  This satisfies "default OFF for all non-production environments" for every
  environment that exists today.
- **Granularity (Decision 4):** the **subsystem** gate at `index.ts:250` (whether
  to construct `TaskStore` + mount routes) is **decoupled** from the **fire**
  decision. The subsystem stays up wherever tasks are configured (so list +
  next-run display work in dev); `mayFire` gates only the actual `dispatch`. Pass
  `mayFire` into the scheduler; `registerTask` still registers crons (so
  `getNextRun()` works), but `dispatch()` early-returns when `!mayFire`.

### Defense 2 — `dorkHome`-keyed leader lock

New primitive `apps/server/src/services/tasks/scheduler-lock.ts`:

- **Lock file:** `<dorkHome>/tasks/scheduler.lock` (JSON: `{ pid, hostname,
startedAt, heartbeatAt }`).
- **Acquire** (called in `SchedulerService.start()`): if no file, or the file's
  `heartbeatAt` is older than `STALE_TTL_MS`, write our record atomically
  (`O_EXCL` create, or write-temp+rename) and become leader. If a fresh lock is
  held by another live pid, we are a **follower**.
- **Heartbeat:** while leader, touch `heartbeatAt` on an interval
  (`HEARTBEAT_MS`, e.g. 10s; `STALE_TTL_MS` e.g. 30s = 3 missed beats) so a
  crashed leader's lock becomes steal-able.
- **Release** (in `stop()`): delete the file iff we own it.
- **Follower behavior:** registers crons (display works) but `dispatch()`
  early-returns — only the leader fires. A follower re-attempts acquisition each
  heartbeat tick, so it promotes if the leader dies.
- **Wiring:** add `dorkHome: string` to `SchedulerDeps` (already available at
  `index.ts` where the scheduler is constructed, line 441).

### Defense 3 — Dispatch idempotency on `(taskId, scheduledFireTime)`

**Data model** — new Drizzle table in `packages/db/src/schema/tasks.ts`:

```ts
export const pulseDispatchLog = sqliteTable(
  'pulse_dispatch_log',
  {
    taskId: text('task_id').notNull(),
    scheduledFireTime: integer('scheduled_fire_time').notNull(), // epoch ms of the cron tick
    dispatchedAt: integer('dispatched_at').notNull(),
  },
  (t) => ({ uniq: uniqueIndex('pulse_dispatch_log_task_tick').on(t.taskId, t.scheduledFireTime) })
);
```

Generate the migration with `pnpm --filter @dorkos/db db:generate` (yields
`packages/db/drizzle/0003_*.sql`); `runMigrations` applies it on boot.

**Gate** — in `dispatch()`, before `createRun`:

1. Derive `scheduledFireTime` from the croner job: register the callback as
   `(self) => this.dispatch(task, self.currentRun())` and pass that `Date` (epoch
   ms) through. If `currentRun()` is null (shouldn't happen on a scheduled tick),
   fall back to a quantized `nextRun(prev)` — never wall-clock-at-dispatch (that
   would defeat cross-process dedup).
2. `INSERT … ON CONFLICT DO NOTHING` via Drizzle `.onConflictDoNothing()`; read
   whether a row was inserted (`result.changes === 1` on better-sqlite3). **Only
   the process whose insert won proceeds** to `createRun`; a conflict means this
   tick already dispatched → log + return.

This is atomic across processes sharing the SQLite DB and survives restart — it is
the backstop for the lock (covers lock handoff, the brief follower→leader window,
and croner double-fire edges).

**Retention (Open Q4 → resolved):** prune `pulse_dispatch_log` rows with
`scheduledFireTime` older than a generous fixed TTL (**7 days**) inside the
existing `start()` pruning pass alongside `pruneRuns`. The dedup key only needs to
outlive the seconds-to-minutes window in which a duplicate fire is possible; 7
days is comfortably safe and bounds table growth.

### End-to-end firing decision (after this spec)

```
cron tick → callback(self) → dispatch(task, self.currentRun())
  └─ if !mayFire (Defense 1)            → return (dev/non-prod, not overridden)
  └─ if !isLeader (Defense 2)           → return (a peer holds the lock)
  └─ if concurrency cap hit             → return (existing)
  └─ if task disabled/!active           → return (existing)
  └─ INSERT dispatch_log; if conflict (Defense 3) → return (already fired this tick)
  └─ createRun('scheduled') → executeRun(...)   (unchanged)
```

## User Experience

- **Developer (Vite dev server):** tasks still list and show next-run; nothing
  fires. A clear `logger.info` at startup states firing is suppressed and why
  (`reason` from `resolveTasksFiring`). To test firing locally: `DORKOS_TASKS_ENABLED=true pnpm dev`.
- **Installed CLI / cockpit (`NODE_ENV=production`):** fires as today, gated by the
  leader lock so only one process fires.
- **Operator with N servers on one `~/.dork`:** exactly one fires; the lock file is
  human-readable (`cat ~/.dork/tasks/scheduler.lock` shows the holder). A killed
  leader's lock is stolen within `STALE_TTL_MS`.
- **Future preview/staging:** off by default once the `deployEnv` seam is wired;
  until then it must run with `DORKOS_TASKS_ENABLED=false` (documented).

## Testing Strategy

- **Unit — `resolveTasksFiring`** (pure, table-driven): dev→off; prod+enabled→on;
  prod+disabled→off; explicit `true` in dev→on; explicit `false` in prod→off;
  `deployEnv='preview'`→off even at `NODE_ENV=production`. Each case a named purpose.
- **Unit — `scheduler-lock`:** acquire when absent; follower when a fresh lock is
  held; steal when `heartbeatAt` is stale; release only when owner; heartbeat
  advances `heartbeatAt`. Use a temp `dorkHome` dir; no real time waits — inject a
  clock.
- **Unit — idempotency:** first `dispatch` for a `(taskId, tick)` inserts and
  proceeds; a second is a no-op (conflict); different ticks both proceed; retention
  prunes rows past TTL. Use an in-memory/temp Drizzle DB.
- **Integration — scheduler:** with `mayFire=false`, a fired cron creates **no**
  run but `getNextRun()` is non-null (display intact). With two scheduler instances
  on one temp `dorkHome` + DB, a shared tick yields exactly **one** run (lock +
  idempotency together).
- **Mocking:** inject a clock into lock + retention; use `FakeAgentRuntime` for the
  agent side; temp dirs for `dorkHome`; a fresh migrated temp DB per test.

## Performance Considerations

Negligible: one extra indexed SQLite insert per scheduled tick (microseconds); a
lock-file `stat`/touch per heartbeat (10s interval). No hot path affected.

## Security Considerations

This **is** a security/safety feature — it prevents unauthorized autonomous
outward action (real Linear writes) from unauthorized environments. The lock file
contains only pid/hostname/timestamps (no secrets). The env gate fails **closed**:
any unrecognized/unset state defaults to not firing outside production.

## Documentation

- `contributing/` (tasks/scheduler guide, if present) + a note in the tasks docs:
  the firing matrix (`NODE_ENV` × `DORKOS_TASKS_ENABLED` × `scheduler.enabled`),
  the leader-lock file location, and the future-preview `DORKOS_DEPLOY_ENV` seam.
- `.env` example: document `DORKOS_TASKS_ENABLED` as the local force-on/off.
- Update the changelog on EXECUTE.

## Implementation Phases

Three independent, individually-correct commits behind this one spec:

- **Phase 1 — Production gate (Defense 1):** `resolve-firing.ts` + decouple the
  subsystem gate from the fire decision in `index.ts`/scheduler + unit tests.
  Ships the headline safety win alone.
- **Phase 2 — Leader lock (Defense 2):** `scheduler-lock.ts` + `dorkHome` wiring +
  acquire/heartbeat/release in `start()`/`stop()` + follower no-fire + tests.
- **Phase 3 — Idempotency (Defense 3):** Drizzle table + migration `0003` +
  `dispatch()` dedup gate via `currentRun()` + retention prune + tests.

## Open Questions

- ~~**Q1 — env-gate semantics / preview deployments.**~~ **(RESOLVED — operator,
  2026-06-25.)** _Answer:_ no preview/staging DorkOS server exists today; it must
  default OFF for all non-production environments. _Rationale:_ "production" means
  the real production deployment, not merely a production build — handled by the
  `resolveTasksFiring` `deployEnv` seam (off-by-default for any named non-prod
  deploy) with `NODE_ENV==='production'` as today's production signal.
- ~~**Q3 — does idempotency apply to manual triggers?**~~ **(RESOLVED.)** _Answer:_
  no — scheduled fires only. _Rationale:_ a manual trigger (`triggerManualRun`) is
  an explicit human/agent act with no `scheduledFireTime` key; the dedup gate lives
  in `dispatch()` (the scheduled path), never in the manual path.
- ~~**Q4 — dedup retention cadence?**~~ **(RESOLVED.)** _Answer:_ fixed 7-day TTL
  prune co-located with the existing `start()` run-pruning. _Rationale:_ the key
  only needs to outlive the seconds-to-minutes duplicate-fire window; 7 days bounds
  growth with ample margin.

No open questions remain; the spec is implementation-ready.

## Related ADRs

- **ADR-D — Pulse scheduling is production-gated + singleton-locked** (seeded as a
  draft by this spec from the roadmap draft; promotes into `decisions/`). Records
  the three-defense decision and the `deployEnv` forward-compatibility seam.

## References

- DOR-149 (tracker); ideation [`01-ideation.md`](./01-ideation.md).
- `plans/agent-harness-portability-roadmap.md` §7 (D1), §8 (ADR-D), §9 (Phase 1).
- Firing chokepoint: `apps/server/src/services/tasks/task-scheduler-service.ts`
  (`dispatch`, `registerTask`, `start`, `stop`).
- Existing gate: `apps/server/src/index.ts:247-265`, `:441`, `:793`, `:849`.
- Env: `apps/server/src/env.ts:3-7,14,30`. DB: `packages/db/src/schema/tasks.ts`,
  `packages/db/drizzle/`, `packages/db/src/index.ts`.

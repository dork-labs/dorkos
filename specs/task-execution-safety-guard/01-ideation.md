---
slug: task-execution-safety-guard
number: 261
created: 2026-06-25
status: ideation
linearIssue: DOR-149
---

# Dev/Preview Task-Execution Safety Guard

**Slug:** task-execution-safety-guard
**Author:** Dorian Collier (via /flow)
**Date:** 2026-06-25
**Tracker:** DOR-149 (P1 · urgent) — project _Tasks — Execution Safety & Skill Unification_
**Decided direction:** ADR-D in [`plans/agent-harness-portability-roadmap.md`](../../plans/agent-harness-portability-roadmap.md) (§8)

---

## 1) Intent & Assumptions

- **Task brief (verbatim from DOR-149):** "Today there is no `NODE_ENV` gate, no
  leader election, no lock: dev servers fire crons and N servers sharing a
  `dorkHome` fire N times (the /flow Pulse seat could act on real Linear from
  dev). Add production-gated firing by default (`DORKOS_TASKS_ENABLED` to opt in
  for dev), a `dorkHome`-keyed leader lock, and dispatch idempotency on
  `(taskId, scheduledFireTime)`."
- **Why now / why P1:** the `/flow` Pulse seat makes a mis-fire _consequential_ —
  a dev server firing a scheduled task could take **autonomous outward action on
  real Linear** (claim/transition/comment) from a developer's laptop. This is a
  safety guard for the very autonomous loop DorkOS is dogfooding.
- **Three independent defenses (ADR-D), defense-in-depth:**
  1. **Production-gated firing** — dev/preview servers don't fire unless
     `DORKOS_TASKS_ENABLED=true`.
  2. **`dorkHome`-keyed leader lock** — of N servers sharing one `dorkHome`, only
     the leader fires (closes the Vercel-cron-style multi-fire risk).
  3. **Dispatch idempotency** on `(taskId, scheduledFireTime)` — even if the gate
     or lock is bypassed (manual trigger race, lock handoff, croner edge), a given
     scheduled fire dispatches at most once.
- **Assumptions:**
  - The server is the only thing that fires crons (croner lives in
    `task-scheduler-service.ts`); the CLI/desktop reuse that server. No second
    scheduler exists.
  - "Production" is best detected by `NODE_ENV === 'production'`, which already
    cleanly separates the Vite **dev server** (`development`) from the **built CLI
    cockpit** (`production`, real `~/.dork`). The intent is: dev server must not
    fire; the built cockpit may (it's how we dogfood Pulse).
  - The three defenses are **independent and individually shippable**; the guard
    is correct with any subset, fully correct with all three.
- **Out of scope:**
  - **D2/D3/D4** (sibling issues DOR-150/151/152): tasks-into-skills unification,
    `dorkos tasks list`, flow-drain-in-plugin. D1 is explicitly the _independent,
    unblocked-today_ Phase-1 item; it must not wait on the unification redesign.
  - Reworking the run-execution path (Relay vs direct), concurrency cap, or the
    task file format.
  - A distributed/multi-host lock — the lock is scoped to one `dorkHome` on one
    machine (the documented multi-writer hazard), not cross-host consensus.

## 2) Pre-reading Log

- `plans/agent-harness-portability-roadmap.md` (§7 D1, §8 ADR-D, §9 Phase 1):
  D1 is the urgent safety guard; ADR-D records the decision (production-gated +
  singleton-locked + idempotent). Phase 1 marks it **unblocked today** and
  independent of the big B-phase bet.
- `apps/server/src/services/tasks/task-scheduler-service.ts` (484 lines): the
  firing engine. `start()` → `registerTask()` builds a `croner` `Cron(cron,
{protect:true,timezone}, cb)` whose callback calls `dispatch(task)`.
  `dispatch()` checks the concurrency cap + re-reads task state, then
  `store.createRun(taskId,'scheduled')` → `executeRun()` (branches Relay vs
  direct). **The single firing chokepoint is `dispatch()` (line ~252).**
- `apps/server/src/index.ts` (lines 247-265): the **existing** coarse gate —
  `tasksEnabled = 'DORKOS_TASKS_ENABLED' in process.env ? env.DORKOS_TASKS_ENABLED
: schedulerConfig.enabled`. When off, the `TaskStore` is never constructed and
  the scheduler never starts (no display, no routes).
- `apps/server/src/env.ts` (lines 3-7, 30): `DORKOS_TASKS_ENABLED` **already
  exists** as a `boolFlag` (`z.enum(['true','false']).default('false')`), next to
  `DORKOS_A2A_ENABLED` / `DORKOS_RELAY_ENABLED`. `NODE_ENV` is a validated enum
  (`development|production|test`, default `development`).
- `apps/server/src/services/tasks/task-state.ts`: `isTasksEnabled()` /
  `setTasksEnabled()` — a process-global flag mirror, already consumed by
  `routes/config.ts`, the runtime `context-builder.ts`, and `message-sender.ts`.
- `apps/server/src/services/tasks/task-store.ts`: `TaskStore` is **SQLite-backed**
  (`new TaskStore(db)`), with `createRun()`, `markRunningAsFailed()` (crash
  recovery), `pruneRuns(retentionCount)` (retention). A natural home for a durable
  idempotency record shared across processes that share the same `dorkHome` DB.
- `apps/server/src/lib/dork-home.ts`: the single source of truth for the data
  directory — the lock's natural key/home (`<dorkHome>/tasks/scheduler.lock`).

## 3) Codebase Map

- **Primary components:**
  - `task-scheduler-service.ts` — `start()` (registration), `registerTask()`
    (croner job), **`dispatch()`** (the firing chokepoint), `stop()` (cleanup).
  - `index.ts` — server bootstrap; owns the current enable gate + scheduler
    lifecycle (`schedulerService.start()` at line ~794, `stop()` on shutdown).
  - `env.ts` — `DORKOS_TASKS_ENABLED` + `NODE_ENV` (the gate inputs).
  - `task-store.ts` (SQLite) — run persistence; candidate idempotency store.
  - `task-state.ts` — the `isTasksEnabled()` process mirror.
- **New surface introduced:**
  - A **leader-lock** primitive (greenfield) — `lib/` or `services/tasks/`.
  - An **idempotency** check + record (greenfield) — in/alongside `TaskStore`.
  - An **effective-firing predicate** that composes env-gate ∧ leadership.
- **Feature flags/config:** `DORKOS_TASKS_ENABLED` (env, exists), `NODE_ENV`
  (env, exists), `scheduler.enabled` (config.json via `configManager`).
- **Blast radius:** the scheduler firing path only. Display/list/CRUD of tasks,
  manual triggers, and run execution mechanics are untouched (manual triggers
  still subject to idempotency only at the `scheduledFireTime` key — a manual run
  has no scheduled key, so it is never deduped against a scheduled one; see Q3).

## 4) Root Cause Analysis

- **Observed vs Expected:** _Observed_ — any running server (dev Vite server on
  :6242, a second cockpit, a stale process) fires every enabled cron; N servers
  sharing `~/.dork` fire N×. _Expected_ — exactly one fire per scheduled tick, and
  only from an environment authorized to act outward.
- **Root cause:** firing has **no environment gate beyond a single boolean
  subsystem switch**, **no cross-process coordination** (each process has its own
  in-memory `croner` jobs), and **no fire-time dedup** (`dispatch()` creates a run
  unconditionally once past the concurrency cap + state check).
- **Evidence:** `task-scheduler-service.ts:252` `dispatch()` — the only gate is
  `activeRuns.size >= maxConcurrentRuns` and the enabled/active re-read; nothing
  keys on environment, leadership, or fire-time. `index.ts:250` — the enable gate
  is a single boolean, not `NODE_ENV`-aware.

## 5) Research — solution shape per defense

### Defense 1 — Production-gated firing

The flag plumbing exists; the **default semantics** are wrong (config-driven, not
production-gated). Proposed effective predicate at the firing decision:

```
mayFire = explicitEnvOverride            // DORKOS_TASKS_ENABLED set → wins either way
        ?? (isProduction && scheduler.enabled)   // default: prod only, honoring the master switch
```

- `isProduction := NODE_ENV === 'production'`.
- Keeps `schedulerConfig.enabled` as the user's master on/off; adds the
  production floor; `DORKOS_TASKS_ENABLED` is the explicit override (force-on in
  dev for cockpit dogfooding, force-off anywhere).
- **Granularity choice (Q4):** ADR-D says dev "discovers/displays but doesn't
  fire." Today's gate is _coarse_ (no scheduler at all when off). Recommendation:
  keep the coarse **subsystem** gate (TaskStore/routes) for "tasks on at all," but
  move the **fire** decision into the scheduler so a non-firing environment can
  still register jobs and surface `getNextRun()` for display.

### Defense 2 — `dorkHome`-keyed leader lock

- **Mechanism options:** (a) `proper-lockfile` (battle-tested, handles staleness);
  (b) hand-rolled lockfile `<dorkHome>/tasks/scheduler.lock` carrying `{pid,
hostname, startedAt, heartbeatAt}` with a staleness TTL + periodic heartbeat
  touch; (c) OS advisory lock (`flock`/`O_EXCL`).
- **Recommendation:** **(b) a hand-rolled `dorkHome`-keyed lockfile with PID +
  heartbeat + staleness TTL** — no new dep, full control over the steal-on-stale
  policy, and the lock content doubles as an operator-debuggable "who holds the
  scheduler" record. (Verify whether a lockfile dep is already vendored before
  finalizing — see Q2.) Acquire in `start()`; if not acquired, register jobs but
  set the leader flag false (display works, firing suppressed); heartbeat on an
  interval; release in `stop()`; steal if the heldlock's heartbeat is older than
  the TTL (crash recovery).

### Defense 3 — Dispatch idempotency on `(taskId, scheduledFireTime)`

- **Key:** `scheduledFireTime` = the cron's _intended_ tick, not wall-clock at
  dispatch (croner exposes the scheduled trigger time to the callback; quantize to
  the schedule to make the key stable across processes).
- **Store options:** (a) a dedicated SQLite table
  `task_dispatch_log(task_id, scheduled_fire_time)` with a **UNIQUE** constraint →
  `INSERT … ON CONFLICT DO NOTHING` returns whether _this_ process won the fire;
  (b) derive from the existing `runs` table (is there a `scheduled` run for this
  task at this fire-time?).
- **Recommendation:** **(a) a unique-constrained dedup record** — atomic across
  processes sharing the SQLite DB, survives restart, trivially testable, and
  cleaned up by the existing `pruneRuns`-style retention. The `INSERT OR IGNORE`
  is the gate: dispatch only when the insert affected a row.

## 6) Decisions (recommended — pending review-gate confirmation)

These are the agent's recommended resolutions, recorded so SPECIFY can proceed;
the human-review gate may override any of them.

| #   | Decision                       | Recommended choice                                                                                                                 | Rationale                                                                                                                    |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Env-gate semantics             | `mayFire = DORKOS_TASKS_ENABLED (if set) ?? (NODE_ENV==='production' && scheduler.enabled)`                                        | Matches ADR-D; dev server (`development`) never fires, built cockpit (`production`) may; explicit flag overrides either way. |
| 2   | Leader-lock mechanism          | Hand-rolled `<dorkHome>/tasks/scheduler.lock` (PID + heartbeat + staleness TTL), steal-if-stale                                    | No new dep, debuggable, full control of crash-recovery policy. Confirm no lockfile dep already vendored (Q2).                |
| 3   | Idempotency store              | Dedicated SQLite table, `UNIQUE(task_id, scheduled_fire_time)`, `INSERT OR IGNORE` as the gate                                     | Atomic cross-process, durable, testable; reuses the existing `TaskStore`/`db` + retention.                                   |
| 4   | Gate granularity               | Coarse subsystem gate stays; **fire** decision moves into the scheduler (register-but-don't-fire when not leader / not authorized) | Honors ADR-D "discovers/displays but doesn't fire"; keeps `getNextRun()` display working in dev.                             |
| 5   | Lock vs idempotency redundancy | Keep **both**                                                                                                                      | Defense-in-depth: idempotency covers lock-handoff races, manual-vs-scheduled races, and croner double-fire edges.            |

### Open questions for SPECIFY

- **Q1 (RESOLVED — operator, 2026-06-25):** there is **no** preview/staging
  deployment running the DorkOS server today. There may be in future, and it
  **must default OFF for all non-production environments.** Implication for the
  gate: "production" must mean the _real production deployment_, not merely a
  production _build_ — a future hosted preview/staging server is a production
  build (`NODE_ENV=production`) that must still not fire. The gate must therefore
  default OFF everywhere except a genuine production deployment, with
  `DORKOS_TASKS_ENABLED=true` as the explicit force-on. Today the only firing
  environment is the installed/built CLI on real `~/.dork`; the Vite dev server
  must not fire. SPECIFY must design the production signal to be forward-compatible
  (an extension point — e.g. a `DORKOS_DEPLOY_ENV`/platform var — so a future
  preview deploy defaults off **without** relying on it remembering to set
  `DORKOS_TASKS_ENABLED=false`). Don't build multi-environment detection before it
  exists (YAGNI), but leave the seam.
- **Q2 (RESOLVED):** no lockfile/leader-election dep is vendored (checked
  `apps/server/package.json` + root) — the leader lock is greenfield, so Decision 2
  (home-rolled) stands. Reference the existing in-repo lock pattern at
  `apps/server/src/services/runtimes/claude-code/sessions/session-lock.ts` for
  style/consistency (note: that one is an in-memory client-id session lock, a
  different concern from a cross-process file lock). croner is `10.0.1`.
- **Q3:** does dispatch idempotency apply to **manual** triggers at all, or only
  to scheduled fires? Recommendation: scheduled only (a manual run is an explicit
  human/agent act and has no `scheduledFireTime` key).
- **Q4:** retention/cleanup cadence for the dedup table (piggyback `pruneRuns`, or
  a TTL sweep keyed on `scheduled_fire_time` older than the longest cron period?).

## 7) Recommended next step

**Advance to SPECIFY.** The problem, the decided direction (ADR-D), the firing
chokepoint, and the three insertion points are all pinned to concrete code. The
remaining unknowns (Q1-Q4) are mechanism details that SPECIFY resolves and seeds
into a draft ADR-D (promoting the roadmap draft into `decisions/`). Estimate 5;
stays a single spec-bound `task` (under the xl sub-issue threshold). The three
defenses can land as three reviewable commits behind one spec.

---
number: 285
title: Pulse scheduling is production-gated, singleton-locked, and idempotent
status: draft
created: 2026-06-25
spec: task-execution-safety-guard
superseded-by: null
---

# 285. Pulse scheduling is production-gated, singleton-locked, and idempotent

## Status

Draft (auto-extracted from spec: task-execution-safety-guard)

## Context

The task scheduler (`task-scheduler-service.ts`) fires a croner job per enabled
task with no environment gate beyond a single config boolean, no cross-process
coordination, and no fire-time dedup. So a dev server fires, and N servers sharing
one `dorkHome` fire N times. The `/flow` Pulse seat makes this consequential: a
mis-fire takes **autonomous outward action on real Linear** (claim/transition/
comment) from an unauthorized environment. This is the urgent (P1) D1 safety guard
of the harness-portability roadmap (was roadmap-draft ADR-D).

## Decision

Adopt three independent, defense-in-depth guards on the firing path:

1. **Production-gated firing.** Centralize authorization in one pure function
   (`resolveTasksFiring`). Default OFF for every non-production environment;
   `NODE_ENV==='production'` (plus the `scheduler.enabled` master switch) is
   today's production signal; `DORKOS_TASKS_ENABLED` is an explicit override in
   both directions. A `deployEnv` parameter is the **forward-compatibility seam**
   so a future hosted preview/staging server (a production _build_) defaults off
   without relying on it opting out. The **subsystem** gate (display/list) is
   decoupled from the **fire** decision, so dev still discovers and displays tasks.
2. **`dorkHome`-keyed leader lock.** A `<dorkHome>/tasks/scheduler.lock` file
   (pid + heartbeat + staleness TTL, steal-if-stale) elects one firing leader per
   `dorkHome`; followers register crons (display) but never fire.
3. **Dispatch idempotency.** A SQLite table with `UNIQUE(task_id,
scheduled_fire_time)`; `INSERT OR IGNORE` in `dispatch()` ensures a given
   scheduled tick dispatches at most once, even if the gate and lock are bypassed.
   The key is the trigger time **floored to the cron's resolution** (60s for
   minute/alias crons, 1s for 6-field crons): croner's `currentRun()` is
   wall-clock-at-trigger, not the scheduled boundary, so flooring is what makes two
   co-located processes agree on one key (verified against croner@10.0.1 in review).
   Manual triggers are exempt.

## Consequences

### Positive

- Closes the Vercel-cron-style multi-fire risk and prevents autonomous outward
  action from dev/preview. The env gate **fails closed**.
- The three guards are independent, individually correct, and individually
  shippable; idempotency is a durable backstop for the lock's handoff window.
- One-function production-authorization seam makes future deployment-environment
  detection a localized change (no scattered `NODE_ENV` checks).

### Negative

- One config gate, a lock file, and a dedup table to manage (heartbeat interval,
  staleness TTL, 7-day retention prune).
- `NODE_ENV==='production'` is only a proxy for "real production" until the
  `deployEnv` seam is wired; an interim hosted non-prod deploy must set
  `DORKOS_TASKS_ENABLED=false` explicitly.

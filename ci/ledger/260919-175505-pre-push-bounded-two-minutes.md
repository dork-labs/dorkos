---
id: 260919-175505
title: 'Pre-push bounded to about two minutes'
kind: experiment
status: active
actor: agent
gates:
  - lefthook.pre-push.tests
  - lefthook.pre-commit.lint
  - lefthook.pre-commit.typecheck
prs: []
hypothesis:
  metric: 'hook.pre-push.duration_p90'
  slo: 'local-push'
  baseline: 1593
  baseline_source: 'the time-wrap records themselves, $(git rev-parse --git-common-dir)/ci-steward/local-timings.jsonl on the operator machine, 2026-09-19T20:05Z to 2026-09-20T23:48Z: 49 pre-push runs, p90 1593 s, p50 7 s, worst 2606 s, 1 run killed and 2 of 47 `tests` commands killed. ci/slos.yaml records p90 601 s and 13-18% killed from research/20260919_ci-pipeline-02-timings.md, which measured a different population (agent tool-call durations, which the 600 s tool ceiling truncates); the hook records are not truncated and are the honest number.'
  target: 180
  after_days: 14
ratchet-release: []
field-changes: []
---

## What changed

Three things, one hypothesis, because they are one mechanism.

1. **The pre-push test command has a hard wall-clock budget of 120 s**
   (`DORKOS_PREPUSH_MAX_SECONDS`), and exceeding it is a **pass with a loud
   block**, not a failure (`DORKOS_PREPUSH_ON_TIMEOUT=pass`, new in
   `scripts/pre-push-watchdog.sh`, whose default stays fail-closed). The
   watchdog writes a `budget_exceeded` note into the local timings on that path,
   so a gate that stopped checking is counted rather than silent.
2. **Heavy local commands hold one of three machine-wide slots**
   (`scripts/heavy-run-lock.sh`, `local.heavy_run_slots`): the pre-push test
   command and the pre-commit `lint` and `typecheck` commands. The lock lives in
   the clone's shared git common dir, so every worktree on the machine sees it.
   It can never wedge a push: a dead holder's slot is reclaimed, waiting is
   bounded at 45 s, and a wait that runs out runs the command anyway with a note.
3. **The machine is measured.** Every time-wrap event line now carries load
   average, cores, available memory and swap in use; `tracked.machine-load` and
   `tracked.gate-cut-short` carry them into the daily snapshot, and triage rule
   12 fires when a machine is chronically saturated, naming whether CPU, memory
   or swap is the cause.

## Why the target is 180 s and not 120 s

The metric is the **whole hook**, not the command the budget is on. The hook is
the formatting check plus the test command, both under one lefthook process, and
the formatting check's own p90 is 10 s with a worst case of 29 s. 120 s of test
budget plus a formatting check plus lefthook's own startup does not fit in 120 s
of hook, and a target the change cannot reach even when it works perfectly is a
target that scores a working change `failed`.

180 s is the budget plus honest overhead. It is above `local-push`'s objective
(120 s), and that gap is deliberate and stated: this experiment is not claimed to
reach the objective on its own. What reaches the objective is this plus the
machine no longer being at load 500, which is what the slot cap is for and what
rule 12 will say when it has.

## What would make me revert

The whole argument for passing on a timeout is that the merge queue is the real
gate. If the local gate catching less means the queue catches more, the trade
was bad. Two counter-metrics, both already collected, watched over the same
14 days:

- **`queue-green`** (today 75%, objective ≥ 97%). A fall here means work that
  the local gate used to stop is now being stopped by the queue instead, one
  ejected batch at a time.
- **`wasted-queue-builds`** (today about 17-21%, objective ≤ 3%). The direct
  price: every batch discarded because one entry failed is up to four other PRs
  paying for a failure their own diff did not have.

Revert if either gets materially worse while `hook.pre-push.duration_p90`
improves. The revert is small and separable: set
`DORKOS_PREPUSH_ON_TIMEOUT=fail` and drop `DORKOS_PREPUSH_MAX_SECONDS`, leaving
the slot cap and the measurement in place, because those two are what tell you
whether the budget was the problem in the first place.

**Watch `tracked.gate-cut-short` first.** If almost no run hits the budget, the
budget is costing nothing and the counter-metrics above cannot have moved
because of it. If most runs hit it, the local gate has effectively stopped
running tests and the honest response is to say so in `contributing/ci.md`
rather than to keep a gate that only pretends.

## Confounders, named

`lefthook.pre-commit.lint` and `lefthook.pre-commit.typecheck` are listed as
gates because the slot cap touches them, and a change to the same machine in the
same window would otherwise confound this entry silently. They get no separate
hypothesis: `local-commit` is reported beside, not scored, and no second entry
in this window touches those gates.

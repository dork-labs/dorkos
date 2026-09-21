---
id: 260921-022119
title: 'Local vitest runs capped at four workers'
kind: experiment
status: active
actor: agent
gates:
  - lefthook.pre-commit.lint
  - lefthook.pre-commit.typecheck
prs: [1969]
hypothesis:
  metric: 'local-commit'
  slo: 'local-commit'
  baseline: 354
  baseline_source: 'the time-wrap records on the operator machine, 2026-09-19T20:05Z to 2026-09-20T23:48Z: 69 pre-commit runs, p90 354 s, p50 10 s, worst 734 s. Per-command p90: lint 186 s (worst 409 s), typecheck 160 s (worst 473 s).'
  target: 240
  after_days: 14
ratchet-release: []
field-changes: []
---

## What changed

Vitest defaults to one worker per core, so one run on this 14-core, 48 GB
machine is 14 workers and nothing capped it. Local runs are now capped at 4.
CI is exempt: its runners are small and the queue's wall time is an SLO we are
trying to improve, which is the case where more workers help.

Two mechanisms because there are two entry points that do not share a config:
`maxWorkers` in the root `vitest.config.ts` for `pnpm vitest run <path>`, and
`VITEST_MAX_WORKERS` exported by the root `test` and `verify` scripts for the
turbo path. A bare `pnpm --filter <pkg> test` inside a package directory is
reached by neither and stays uncapped.

## What was measured

State of the machine when this was written, with three worktrees' suites live:
53 vitest processes holding 10.0 GB, 187 node processes holding 17.2 GB, swap
10.6 GB of 12.3 GB. Per vitest process: p50 0.11 GB, p90 0.31 GB, max 1.24 GB.

`packages/relay` (1,962 tests), repeated runs at load 360-470:

| workers  | reps | green | wall (mean) | peak tree RSS (mean) |
| -------- | ---- | ----- | ----------- | -------------------- |
| 14 (def) | 5    | 5/5   | 125 s       | 3.12 GB              |
| 8        | 4    | 4/4   | 88 s        | 2.62 GB              |
| 4        | 8    | 5/8   | 120 s       | 1.61 GB              |
| 2        | 1    | 1/1   | 177 s       | 1.05 GB              |

**Memory is the only clean signal**, and it is the reason for 4: about half the
default's footprint, where 8 returns only a sixth of it. **Wall time is not
resolvable on this machine** — load moved between batches, and in the one fairly
interleaved comparison (4 and 14 alternating, three pairs) the means were 110 s
and 117 s. That is noise, so the claim is "no measurable wall-time cost at this
load" and nothing stronger. On an idle machine the uncapped run would win.

## The cost, which is not zero

Three of the eight capped runs went red where none of the nine
uncapped-or-eight-worker runs did, always in `access-control.test.ts` or
`relay-gc.test.ts` — the two relay tests that drive a real filesystem watcher
against a deadline. Run on their own they pass 12/12 at both settings, so this
is contention **inside** the run: at 4 workers each one carries about 19 files
instead of 5, its event loop stays busy longer, and a watcher callback is
likelier to miss its window.

That is a real cost and it is why this entry exists rather than the change
landing as hygiene. The honest fix is to make those two tests deterministic, not
to raise the cap until they stop complaining. Local runs keep `retry: 0` so the
flake stays loud, and any run can opt out with `VITEST_MAX_WORKERS=14`.

## Why `local-commit`, and how it composes

Nothing in the hooks runs vitest, so this cap does not touch a hook directly.
It moves `local-commit` the way everything on this machine moves it: by leaving
memory and CPU for the pre-commit `lint` and `typecheck` runs, whose p90 was
354 s for the whole hook. If the machine stops swapping, that number falls; if
it does not, the cap was not the binding constraint and this entry says so.

It composes with `scripts/heavy-run-lock.sh` rather than duplicating it: the
lock caps concurrent heavy **commands** (3), this caps workers within one
**run** (4). Today they overlap nowhere — the lock guards two turbo tasks that
spawn no vitest workers — so the machine's exposure is 3 concurrent turbo runs
from lock-guarded gates, plus 4 workers per agent-initiated test run with no cap
on how many such runs there are. **Capping concurrent test runs is the obvious
next lever and is deliberately not taken here.**

## The confounder, named

Three levers land on this machine in the same window, and all three plausibly
move `local-commit` and `local-push`. A reader in two weeks must not score any
one of them as if it caused everything:

1. **The pre-push test gate was removed** (`260919-175505`). Scored on
   `local-push`. It is the only one of the three that touches `local-push` at
   all, because nothing else in the push hook changed.
2. **The heavy-run slot cap** (also `260919-175505`, same commit) serialises
   pre-commit `lint` and `typecheck` across worktrees. It can only make
   `local-commit` **slower** — up to a 45 s wait — so it works against this
   entry's target.
3. **This worker cap.** Frees memory and CPU for everything else on the box.

So `local-commit` is moved by 2 and 3 in opposite directions, and `local-push`
by 1 alone. If `local-commit` improves, the honest reading is that 3 outweighed
2; if it worsens, 2 outweighed 3 and the slot cap's wait is the thing to tune.
Either way the verdict engine will see both entries naming
`lefthook.pre-commit.*` in the same window and should return `inconclusive` for
this one on confounding — which is the correct answer, and better than a clean
number nobody can attribute.

## What would make me revert

Any rise in flake beyond the two relay tests already named — that is, a third
file going red on a capped run. The memory this buys is not worth a suite people
stop believing.

The two that are already known are written up in
`ci/ledger/260921-023128-relay-deadline-sensitive-tests.md`, with the measurement
that identifies the condition (3 of 8 capped runs red, 0 of 9 uncapped, 12/12 in
isolation) and the fix direction. Read that before reverting: if the third red
file turns out to be another wall-clock-deadline test, the cap is revealing a
fragility rather than causing one, and the cheaper fix is that test.

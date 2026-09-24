---
id: 260919-175506
title: 'Typecheck leaves pre-commit, staying in pnpm verify and CI'
kind: experiment
status: active
actor: agent
gates:
  - lefthook.pre-commit.lint
prs: []
hypothesis:
  metric: 'hook.pre-commit.duration_p90'
  slo: 'local-commit'
  baseline: 280.6
  baseline_source: 'the time-wrap records on the operator machine, $(git rev-parse --git-common-dir)/ci-steward/local-timings.jsonl, window 2026-09-17T10:44Z to 2026-09-24T10:44Z (the first record in it is 2026-09-19T20:05Z): 841 pre-commit runs, 838 finished, whole-hook p90 280.6 s, p50 31 s, worst 2059 s. Recomputed with packages/ci-steward/src/timings.ts (hookRuns) and time.ts (quantile), the same code the collector uses. Replaces the seeded 210 from plans/ci-steward-plan.md §3.'
  target: 150
  after_days: 14
ratchet-release: []
field-changes: []
---

## What changed

The `typecheck` command is gone from the lefthook `pre-commit` hook. What is
left at commit is prettier on staged files, Drizzle migrations, the
directory-size check, and `turbo lint --affected` under the machine-wide slot
cap. Typecheck still runs in `pnpm verify` (affected-only) and as the required
`typecheck` check on every PR and in the merge queue. It runs nowhere at push:
since DOR-2160 the push hook is one formatting check. The seeded title said
"staying at push", which stopped being true before this entry was activated.

## What was measured

The pre-commit `typecheck` command, same window as the baseline (the week to
2026-09-24T10:44Z, all agents on the operator machine):

- 840 runs, 838 finished (about 120 a day).
- 12.9 hours in total, about 110 minutes a day.
- Per run: p50 17 s, p90 139 s, worst 1398 s.
- 35 failed (4.2%). 9 of those failed in 3 s or less, which is a lock, a stale
  dist or the environment, not a type error. So at most about 26 real catches
  in a week.

Commits outnumber merged PRs about 8 to 1, so the hook re-checked the same
change about eight times per PR. `typecheck` is a required merge-queue check
and runs in `pnpm verify`, so no type error can reach `main` because of this
change. The worst case is that every one of those ~26 catches now surfaces as a
red PR instead, at about 8 minutes each (`pr-feedback` p50 7.7 min): about
3.5 hours a week lost against 12.9 hours saved.

The operator's own read of the same file on 2026-09-24 (838 runs, 37 failed,
p90 142 s) differs only by the minutes between the two windows.

## Why the target is 150 s, not the SLO's 20 s

`lint` stays in the hook and has the same shape as typecheck: p90 140 s over
the same week. Measured from the same records, the whole hook's p90 with the
typecheck span taken out of each run is 143 s. So 150 s is what this change
can deliver on its own, and 20 s (the `local-commit` objective) needs a second
change to lint. The metric is the whole hook, not a gate metric, because the
hook is what a person waits on.

## Why `gates` names lint

The gate this entry removes no longer exists, so it cannot be named here (the
ledger check requires a gate that is in `ci/gates.yaml`). The one heavy command
left in the hook is `lint`, and this change moves it too: lint no longer
shares the slot pool (`scripts/heavy-run-lock.sh`) with typecheck, so it waits
for a slot less often. Naming it is also what lets the verdict code see the
overlap below.

## Overlap with 260921-022119 (local vitest worker cap)

That entry names `lefthook.pre-commit.lint` and scores `local-commit`, and its
after-window runs to 2026-10-05. This change lands inside that window and moves
the same hook far more directly, so CI Steward will list this entry as a
confounder there. That is the correct answer, and neither entry's hypothesis
has been edited to avoid it. That entry was already confounded by
260919-175505 (same PR, same gates), and its own text says vitest workers and
the pre-commit commands overlap nowhere, so its `local-commit` reading was
always going to be a weak attribution. In the other direction, that entry
merged before this one, so it sits in this entry's before-window, not its
after-window, and does not confound this verdict.

## What would make me revert

The guardrail is the PR-side `typecheck` failure rate,
`gate.wf.typecheck.typecheck.failure_rate@pull_request`. Baseline, measured
2026-09-23: 2 failures in 204 completed `pull_request` runs of `typecheck.yml`
since 2026-09-16, about 1%.

Revert when the extra CI round trips cost more than the commit time saved. The
break-even: 12.9 hours a week saved ÷ about 8 minutes per extra red PR ≈ 95
extra reds a week. On today's ~200 PR runs a week that is a failure rate near
48%, from 1%. Anything under that still saves time. A rate above about 10%
(some 18 extra reds, ~2.4 hours) is still a net win, but is the point to look
at which failures they are before the verdict comes in.

Secondary metric: `local-commit` p90, the SLO this serves (floor 210 s,
objective 20 s). If the hook's p90 does not fall below the 210 s floor, the
time went somewhere other than typecheck, and that is worth knowing too.

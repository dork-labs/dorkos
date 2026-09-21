---
id: 260919-175505
title: 'The test gate leaves pre-push'
kind: experiment
status: active
actor: agent
gates:
  - lefthook.pre-push.formatting
  - lefthook.pre-commit.lint
  - lefthook.pre-commit.typecheck
prs: []
hypothesis:
  metric: 'local-push'
  slo: 'local-push'
  baseline: 1593
  baseline_source: 'the time-wrap records on the operator machine, $(git rev-parse --git-common-dir)/ci-steward/local-timings.jsonl, 2026-09-19T20:05Z to 2026-09-20T23:48Z: 49 pre-push runs, p90 1593 s, p50 7 s, worst 2606 s, 1 run killed and 2 of 47 `tests` commands killed. An independent recompute during review read p90 1654 s on a slightly later window. ci/slos.yaml records p90 601 s from research/20260919_ci-pipeline-02-timings.md, which is DISCARDED here: it measured agent tool-call durations against a 600 s tool ceiling, so 601 is the ceiling plus one second — a censored distribution, not a measurement.'
  target: 30
  after_days: 14
ratchet-release: []
field-changes: []
---

## What changed

The `tests` command is gone from `pre-push`. What remains at push is the
formatting check. At commit, `lint` and `typecheck` stay, and each now holds one
of three machine-wide slots.

The original proposal — bound the test gate to about two minutes and pass on a
timeout — was implemented, reviewed, and rejected on its own measurement. This
entry records what was actually done.

## The cliff, which is why a budget was the wrong answer

Across 68 `pre-push.tests` command runs on the operator machine:

| runs | duration                                     |
| ---- | -------------------------------------------- |
| 58   | under 50 s                                   |
| 0    | 50 s to 579 s                                |
| 10   | over 579 s (worst 2604 s; 2 killed outright) |

There is no middle. The 58 are pushes whose affected set was empty or trivial,
where the gate ran nothing and proved nothing. The 10 are pushes that had real
work, and on this machine none of them finished in anything a person waits for.

Put any budget against that distribution and it lands in the empty band. A
two-minute bound returns **no verdict on a single push that had work to do**,
while charging two minutes to every one of them. Worse for the experiment
itself: `tracked.gate-cut-short` would have read about 15% and been dominated by
pushes that had nothing to test, so even "is the budget costing us anything"
would have had no answer. Raising the bound only walks back toward the
26.6-minute p90 that made agents type `--no-verify` in the first place.

A gate that cannot return a verdict is not a cheap gate. It is theatre with a
bill attached, paid on every push by every agent on the machine.

## What still catches a break

- The **merge queue** runs the full monorepo suites, lint, typecheck and the
  browser shards against `main` plus everything ahead of the PR, and refuses the
  merge if any of them fail. It is unchanged and it is the guarantee.
- The **PR's affected-only `test` leg** reports a break in about 14 minutes,
  with nobody waiting at a terminal.
- The **formatting check stays at push**, because it is the one local check
  whose verdict is both certain and cheaper than hearing it from CI: p90 10 s,
  deterministic, and it preempts `prettier --check .` inside the required `lint`
  job, which seven PRs across five sessions went red on in one week.

Nothing that reaches `main` reaches it with less checking than before. What went
away is a local step that either tested nothing or could not finish.

## Why this metric, and why the last one was a tautology

The first draft named `hook.pre-push.duration_p90` against a 180 s target while
the change mechanically capped that hook at about 120 s. That is not a
hypothesis; it is arithmetic wearing a hypothesis's clothes, and it would have
been scored `verified` by construction.

With the gate removed there is no cap, so `local-push` is load-bearing again:
what remains at push is a real command whose duration is decided by the diff and
the machine, and it can fail to improve for reasons worth knowing about. A p90
of 30 s is the claim. The formatting check's own p90 was 10 s with a worst case
of 29 s over the same window, so 30 s says the hook is now that check plus
lefthook's own startup and nothing else — and it leaves room for the check to
be slow on a large diff without the entry being wrong.

`local-push`'s second floor, `killed_share`, should go to zero: nothing left in
the hook runs long enough for the agent tool ceiling or the kernel to reach it.
That is reported beside, not scored, because 49 runs is a thin denominator for a
share that was already only 2%.

## What would make me revert

The claim is that the local gate was catching nothing worth its cost. If that is
wrong, the work it used to stop now arrives at the queue instead. Two
counter-metrics, both already collected, over the same 14 days:

- **`queue-green`** (today 75%, objective ≥ 97%). A fall means breaks that the
  local gate used to stop are being stopped by the queue instead, one ejected
  batch at a time.
- **`wasted-queue-builds`** (today about 17-21%, objective ≤ 3%). The direct
  price: every batch discarded because one entry failed is up to four other PRs
  paying for a failure their own diff did not have.

Revert if either gets materially worse while `local-push` improves. The revert
is a single command block returning to `lefthook.yml`; the slot cap and the
machine measurement are independent of it and would stay.

**Read the counter-metrics with the 58 in mind.** Most pushes never had a test
verdict to lose — their affected set was empty — so if `queue-green` falls, the
cause is concentrated in the small number of pushes that did, and it should be
attributable to specific ejections rather than to a general drift.

## Confounders, named

Three gates are listed because this change touches all three, and a second
change to the same machine in the same window would otherwise confound the
entry silently. Only `local-push` is scored. `local-commit` is reported beside
it: the slot cap can only make a commit slower — a wait of up to 45 s — and if
it shows up there, that is the cap working, not a regression to chase. No other
active entry names any of these gates.

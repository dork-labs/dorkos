---
id: 260920-175925
title: The automated review finishes the first time (plan §5.3 reliability half)
kind: experiment
status: proposed
actor: agent
gates:
  - wf.claude-code-review.review
  - wf.merge-tail.arm
prs: []
hypothesis:
  metric: review-completes
  slo: review-completes
  baseline: 0.8854
  baseline_source: 'ci-steward latest.json, 7-day window to 2026-09-19, against the 0.90 floor in ci/slos.yaml; the failure breakdown behind it is research/20260919_ci-pipeline-supporting/07-claude-review-effectiveness.md §6 (52 failure logs read over 30 days, 60 successful runs sampled)'
  target: 0.96
  after_days: 14
ratchet-release: []
field-changes: []
---

## What this changes

Reliability only. The review stays advisory and looks for exactly what it looked
for before; making it blocking is 260919-175511 (DOR-2151) and needs the
`review-gate` job first.

1. **The label race.** Runs that will not review now sit in their own
   concurrency group, and the group is keyed by head SHA rather than PR number.
   A concurrency group holds one running plus one pending member, so a third
   entrant evicts the pending one whatever its own `cancel-in-progress` says —
   which is how `gh pr create --label ...` silently cost 23 of 779 merged PRs
   (3.0%) their review.
2. **The turn budget.** `60 + 2 x changed files`, clamped to [80, 120], replacing
   a flat 50 below 30 files and 100 above it.
3. **Dependabot.** `allowed_bots` names the bot, and a preflight step reports the
   missing credential honestly instead of letting it look like a spent quota.
4. **An outcome class per run**, in the job summary and as a
   `review-outcome-class` annotation: `reviewed`, `no_verdict`, `turn_budget`,
   `quota_session`, `quota_weekly`, `quota_unknown`, `no_credentials`, `fork`,
   `infra`.
5. **A retry ladder.** merge-tail re-requests a red review with the `re-review`
   label, waiting at least 10, 20 then 40 minutes and stopping after three tries
   per head SHA.

## Why 0.96

The metric is the share of head SHAs whose FIRST review attempt completed with a
posted verdict, so only item 2 can move it much, and the arithmetic is item 2's:

- the baseline's 11.46% failure rate decomposes, in the 7-day read, as 11 of 14
  failures (79%) being `error_max_turns` at turn 51;
- the turn distribution was censored at that cap — median 32.5, p90 49, max 74
  across 60 successful runs, so every one of them would have fitted in 80;
- removing 79% of an 11.46% failure rate predicts 0.976.

0.96 is deliberately short of that. It leaves room for the failure classes this
change cannot remove: Dependabot runs that still have no credential until the
operator adds one to the repository's Dependabot secrets (5 of 52 failures), PRs
that edit the review workflow and therefore cannot be reviewed by it (3 of 52),
and the reported-success-but-no-verdict class (4 of 52).

## What it deliberately does NOT claim

- **The label-race fix does not move this metric.** A first review cancelled
  before it finished is counted as `review_cancelled` and excluded from the
  population (`packages/ci-steward/src/series.ts`). It should show up as more
  PRs reviewed on their final commit (64% today, report 07 §1) and as fewer
  sub-minute cancelled runs (255 of 258 over 30 days), neither of which is
  scored here.
- **The retry ladder does not move this metric either.** The population is the
  FIRST attempt. Retries are `review-recovery`, whose p90 has never been
  measured because nothing ever retried.
- **The outcome class is not wired into the collector**, on purpose. Re-basing
  `review-completes` to exclude quota stalls (which ci/slos.yaml already says it
  should, once a classifier exists) inside the same window as the changes it is
  measuring would make the before/after comparison meaningless. Emit now,
  re-base in a later entry with its own baseline.

## What would make us revert

- `review-completes` below its 0.90 floor for two consecutive windows.
- `gate.wf.claude-code-review.review.duration_p90@pull_request` rising toward the
  job's 25-minute timeout. A bigger turn budget buys turns with wall clock, and
  a wall-clock kill is worse than a turn-budget failure: it leaves no result
  message, so the failure comes out as `infra` with no cause named. If p90 gets
  past ~15 minutes, lower `REVIEW_MAX_TURNS_MAX` rather than raising the
  timeout.
- Review volume rising materially per merged PR (`tracked.review-runs-per-merged-pr`).
  The ladder's ceiling is 3 retries per head SHA and the review is one full pass;
  if that count climbs, the ladder is retrying something it cannot fix.

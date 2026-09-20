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
   label, stopping after three tries per head SHA, skipping a PR whose last
   attempt died against the subscription's own quota, and clearing a `re-review`
   label stranded on a conflicting PR. The 10/20/40-minute rungs are in the
   script, but see the assumptions below: they do not bind on a cron trigger.

## Operator prerequisites

Two, and neither is something an agent can do. Both fail visibly rather than
silently, but until they are done part of this change is inert:

1. **Grant the `dorkos-merge-tail` GitHub App the `Actions: read` permission**,
   ideally before this merges. Listing a workflow's runs needs it, and the app
   holds contents/pull-requests write plus checks read. Without it the retry
   ladder does nothing and says so once per tick, as an `::error::` annotation
   and a summary line; arming is unaffected. It is a probe rather than a
   `permission-actions: read` input on the token step because those inputs are a
   scope-DOWN: `actions/create-github-app-token` inherits the installation's
   permissions by default and naming even one replaces that set, so adding it
   would have stripped the write scopes arming needs and traded an inert ladder
   for an inert workflow.
2. **Add `CLAUDE_CODE_OAUTH_TOKEN` to the repository's Dependabot secrets.**
   GitHub withholds Actions secrets from Dependabot's `pull_request` runs, so
   until then a Dependabot review fails at the new preflight with an explicit
   message. The retry path reaches those PRs anyway (it runs as the merge-tail
   app, which does get secrets), so this is an improvement, not a blocker.

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

## Assumptions, stated so the verdict can be read against them

- **0.976 assumes every `error_max_turns` run fits under the new ceiling, and
  the sample cannot show that.** The turn distribution was censored at 50: a run
  that died at 51 would have used 51 or 500 turns and the log cannot tell which.
  What is known is that the 60 runs which DID finish topped out at 74. If a
  material share of the deaths were genuine runaways, the budget converts them
  from turn-budget failures into slower turn-budget failures at 80-120, and the
  metric moves less than predicted. That is one of the two ways this comes back
  `partial` rather than `verified`.
- **The label-race fix moves the metric by moving its DENOMINATOR, in the
  direction that makes the target harder.** A first review cancelled before it
  finished is counted as `review_cancelled` and excluded from the population
  (`packages/ci-steward/src/series.ts`); fixing the race means those head SHAs
  now start a real first review and re-enter the denominator. Their outcomes
  should be ordinary — most reviews succeed — so the expected effect is small
  and slightly dilutive, but it is not zero, and an earlier draft of this entry
  wrongly said it was. The clean read of the fix is elsewhere: more PRs reviewed
  on their final commit (64% today, report 07 §1) and far fewer sub-minute
  cancelled runs (255 of 258 over 30 days).
- **The retry ladder does not move this metric.** The population is the FIRST
  attempt. Retries are `review-recovery`, whose p90 has never been measured
  because nothing ever retried.
- **The outcome class is not wired into the collector**, on purpose. Re-basing
  `review-completes` to exclude quota stalls (which ci/slos.yaml already says it
  should, once a classifier exists) inside the same window as the changes it is
  measuring would make the before/after comparison meaningless. Emit now,
  re-base in a later entry with its own baseline.
- **The 10/20/40-minute backoff is not a binding limiter today.** Every rung is
  shorter than one merge-tail tick (median gap 162 minutes), so `SKIP backoff`
  will essentially never fire. What bounds the retry cost is the ceiling of
  three per head SHA and the quota skip. The rungs become real under the
  event-driven trigger that ledger 260919-204500 proposes.

## What would make us revert

- `review-completes` below its 0.90 floor for two consecutive windows.
- A wall-clock kill appearing at all. A bigger turn budget buys turns with wall
  clock, and being killed by `timeout-minutes` is worse than a turn-budget
  failure: the action writes no result message, so the run comes out classed
  `infra` with no cause named. The signals, in order of directness: any
  `infra`-classed review with an empty `Reported:` line under the raised budget;
  then the `headroom` tripwire, which is p95 job duration over `timeout-minutes`
  for this gate and fires at 0.9. `duration_p90` is a supporting reading, not
  the trigger — per ci/metrics.yaml it is job duration, started to completed,
  and queue wait sits outside it, but a check-run's `started_at` is not a
  perfectly clean boundary and a number that can move for runner availability
  should not be the thing that reverts a change. Remedy either way: lower
  `REVIEW_MAX_TURNS_MAX`, never raise the timeout (they are pinned to each other
  in `scripts/test-review-classifier.sh`).
- Review volume rising materially per merged PR (`tracked.review-runs-per-merged-pr`).
  The ladder's ceiling is 3 retries per head SHA and the review is one full pass;
  if that count climbs, the ladder is retrying something it cannot fix.

---
id: 260923-165836
title: merge-tail refuses a GraphQL error body instead of reading it as a clean answer
kind: incident-fix
status: active
actor: agent
gates:
  - wf.merge-tail.arm
prs: [2034]
hypothesis:
  metric: 'gate.wf.merge-tail.arm.failure_rate@schedule'
  slo: 'lead-time'
  baseline: 0
  baseline_source: 'measured 2026-09-23 with `gh run list --workflow merge-tail.yml -L 200`: the latest 200 runs (2026-08-26 to 09-23: 198 schedule, 2 workflow_dispatch) all concluded success, so the 198 scheduled ones give 0; the logs of the latest 60 hold no could-not-read-* or queue-history-unknown skip, so the failure this fixes has not been observed in production yet'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-2271. GitHub answers a failed GraphQL query with a body, `{"data": null, "errors": [...]}`, and
`gh api graphql` prints it on stdout while exiting 1. merge-tail read that body two wrong ways. Under
the `bash -e` GitHub runs the step with, the exit 1 ended the whole tick: every pull request after the
failing one went unexamined, and the run went red with no summary. Without `-e`, the inline jq read
the body as "not queued, no open threads"; only the later queue-history rule kept that from arming.
A failed `gh pr checks` call had the same two shapes: it stopped the tick, or read as "no checks".
Found while porting merge-tail to dork-labs/marketplace (DOR-1706).

The change: `scripts/should-arm-automerge-input.sh` builds the gate's payload from the three answers
and refuses, with one `SKIP <reason>` line carrying GitHub's own message, any answer that is not
really one: not JSON, any reported GraphQL error (a partial answer nulls the failed field, and
`mergeQueueEntry` and a removal's check suites fail toward permission when nulled), no pull request
object, no `mergeQueueEntry` field, no review-thread list, or a check list that is not a list.
A failed metadata, GraphQL or checks read is retried once after 5 seconds before it counts (only
failed reads wait, so a healthy tick costs nothing extra). After 3 PRs in a row stay unreadable the
pauses stop and failed reads count at once, so an inert tick reaches its error in about 30 seconds
at most, even with 100 PRs open. If it fails again, the PR waits one tick and the
tick carries on, with a counted warning. A tick in which EVERY
examined pull request was unreadable fails (`::error::`, exit 1), like a refused arm: a lost
permission or a broken query refuses them all, and a warning alone would stay green for as long as
it lasted. The gate itself now refuses a payload with no
`mergeQueueEntry` field or a non-numeric `unresolvedThreads` instead of defaulting them to the
permissive answer. A failed label re-read before clearing `re-review` is now a counted failure, not
"label already gone". `scripts/test-should-arm-automerge-input.sh` pins every refusal, including the
exact NOT_FOUND body `gh` returns.

Why this metric: the fix removes a latent failure with no measured occurrences, so the honest number
is the one it must not make worse. One unreadable answer no longer fails a tick, and a tick fails
only when it could read nothing at all, which is the inert state this metric should catch. So
`failure_rate@schedule` stays at 0 while the reads work and rises as soon as they stop. Known cost:
a tick goes red when every open pull request fails two consecutive reads of the same kind, 5 seconds
apart, in one tick; with a single open pull request that can still be a longer transient outage.
Partial skips are counted on each run's `unreadable-from-github=` line; check them by hand at the
verdict date by grepping merge-tail logs for `graphql-error` and `could-not-read-`.

Revert if `failure_rate@schedule` rises above 0.05 with the `is inert: GitHub gave no readable
answer` error, while the same PRs read fine by hand: that is a routine partial-error answer this
change treats as no answer.

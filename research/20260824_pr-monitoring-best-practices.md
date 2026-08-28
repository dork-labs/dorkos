---
status: current
topic: Monitoring GitHub pull requests to merge completion (polling, no webhooks)
informs: .agents/skills/creating-pull-requests/scripts/watch-prs.sh
---

# GitHub PR monitoring best practices (2026-08-24)

Researched for the `watch-prs.sh` script in the `creating-pull-requests` skill.
Sources: official GitHub docs, `cli/cli` issues, Mergify docs, practitioner
blogs. Condensed; each claim carries its citation.

## Check semantics

- **`statusCheckRollup`** (GraphQL, on the PR's head commit) aggregates both
  legacy commit statuses and modern check runs — the one field for "did
  everything pass." The lighter `checkRunsByState` sub-field exists because the
  full rollup was slow enough to time out `gh pr status`
  ([cli/cli#7421](https://github.com/cli/cli/issues/7421)).
- **Checks attach to `pull_request.head.sha`**, never the ephemeral
  `refs/pull/N/merge` commit, which is regenerated on every push and can even
  differ between jobs of one run
  ([Ken Muse](https://www.kenmuse.com/blog/the-many-shas-of-a-github-pull-request/),
  [actions/checkout#27](https://github.com/actions/checkout/issues/27)). Key
  polling off the head SHA; anything keyed to a merge SHA is unsafe.
- **Required checks** come from two competing APIs — legacy branch protection
  (`/branches/{b}/protection`) and modern rulesets
  (`/rules/branches/{b}`) — and a repo can use either or both
  ([rules API](https://docs.github.com/en/rest/repos/rules)). There is **no**
  single "why is this PR blocked" endpoint; the reason must be reconstructed
  ([community#162462](https://github.com/orgs/community/discussions/162462)).

## Merge queue

- Queue membership: GraphQL `mergeQueueEntry { position state }`
  ([changelog](https://github.blog/changelog/2023-04-19-pull-request-merge-queue-public-beta-api-support-and-recent-fixes/)).
- **Silent ejection** is only visible via
  `timelineItems(itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT])`, which carries a
  `reason` (e.g. `failed_checks`)
  ([Jamie Tanna](https://www.jvt.me/posts/2026/08/11/github-merge-queue-prs/)).
  No check goes red and no webhook is needed — poll this or never know.
- `autoMergeRequest` = armed intent; `mergeQueueEntry` = actual queue progress.
  Check both.
- **Arming fails on an already-clean PR**: `enablePullRequestAutoMerge` 422s
  with "Pull request is in clean status" — GitHub only arms while something is
  pending; a clean PR must be merged/enqueued directly
  ([peter-evans/enable-pull-request-automerge#343](https://github.com/peter-evans/enable-pull-request-automerge/issues/343)).
- **Queued but zero checks reporting** = the required workflow lacks
  `on: merge_group`; the PR sits forever
  ([Tenki](https://tenki.cloud/blog/github-merge-queue-setup)). This repo fixed
  that on 2026-08-23; the watcher still classifies it (`STALLED_IN_QUEUE`)
  because a new required workflow can reintroduce it.

## `mergeStateStatus`

`CLEAN` mergeable now · `DIRTY` conflicts (act) · `BLOCKED` waiting on required
checks/reviews (poll) · `BEHIND` needs update only where up-to-date is required
(self-resolves under a queue) · `UNSTABLE` non-required check failing (merge
still allowed) · `DRAFT` · `HAS_HOOKS` (GHE) · **`UNKNOWN` = mergeability still
being computed asynchronously — retry with short backoff, never treat as
terminal** ([cli/cli#7401](https://github.com/cli/cli/issues/7401)).

## Rerun semantics

A rerun via `gh run rerun` preserves the original event's `GITHUB_SHA`/refs —
it re-executes the **original merge snapshot**, not current `main`
([docs](https://docs.github.com/en/enterprise-server@3.0/actions/managing-workflow-runs/re-running-workflows-and-jobs),
[cli/cli#5629](https://github.com/cli/cli/issues/5629)). When a PR failed
because _main_ was broken and main has since been fixed, the cure is an empty
commit (fresh event, fresh merge ref), not another rerun. Learned live on
PR #1259, 2026-08-24.

## Polling and rate limits

REST 5,000 req/hr; GraphQL 5,000 points/hr; secondary limits (~900 pts/min
REST, 2,000 pts/min GraphQL, 100 concurrent) bite first under tight loops
([REST](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[GraphQL](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)).
`gh pr checks --watch` polls at 10s with `--fail-fast` and exit code 8 for
still-pending ([manual](https://cli.github.com/manual/gh_pr_checks)); for a
multi-PR agent watcher, 60s+ with per-cycle jitter is plenty and avoids
lockstep across concurrent watchers.

## Flaky checks

No first-party flake API. Mergify's production pattern: retry-once-before-eject
inside the queue, quarantine confirmed-flaky tests from gating, detect via
base-branch reruns
([Mergify](https://docs.mergify.com/changelog/2026-03-18-automatic-ci-retries-in-merge-queue/)).
The agent-side equivalent used here: on a required failure, check whether the
same check fails on recent `main` commits (standing red vs yours) and rerun
once before escalating; a failure that reproduces locally 0/3 is a flake.

## Review threads

Only GraphQL exposes resolution: `reviewThreads { isResolved isOutdated }`;
filter unresolved AND not-outdated
([community#24854](https://github.com/orgs/community/discussions/24854)).
`gh` has no native surface ([cli/cli#12273](https://github.com/cli/cli/issues/12273)).
These block this repo's merge-tail arming while every check is green.

## Prior art

`gh pr checks --watch` (reference loop), `gh-observer` (single GraphQL query,
backoff, TUI), Mergify docs (queue edge cases), Jamie Tanna's ejection
detector. The `watch-prs.sh` classifier + fixture test
(`test-watch-prs.sh`) encode all of the above.

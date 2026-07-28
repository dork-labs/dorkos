---
id: 260728-112203
title: The merge queue replaces require-branches-up-to-date, and arming a merge is somebody's job
status: accepted
created: 2026-07-28
spec: null
superseded-by: null
---

# 260728-112203. The merge queue replaces require-branches-up-to-date, and arming a merge is somebody's job

## Status

Accepted. Amends the operating assumption of
[0276](0276-auto-merge-on-approval-recovery-ladder.md) rather than reversing it: that ADR's
merge tail is still the right design, but it only ever ran in a code path that is off by
default, so in practice no pull request in this repo ever merged itself.

## Context

On 2026-07-28, with roughly twenty agents working in parallel and about sixty commits landing
on `main` in twenty-four hours, nine pull requests were open and six of them could not merge.
All six were green, carried no unresolved review findings, and had auto-merge armed. The oldest
had been in that state for nine hours and was seventeen commits behind. Nothing was failing and
nothing was waiting on a human decision. They simply could not merge, and nothing said so.

Two independent faults produced that, and each one alone would have been survivable.

**Nobody armed auto-merge.** ADR-0276's auto-merge recovery ladder is real and implemented, but
it lives in the flow plugin behind autonomous Pulse mode, which is `enabled: false` in v1.
Outside that loop the `flow-drain` skill deliberately stops agents at the review gate, and the
`gh pr merge --auto` instruction in the `creating-pull-requests` skill is prose that nothing
executes. Landing a finished pull request was therefore an unowned manual step, and it was being
done by hand, one pull request at a time.

**Armed pull requests could not merge anyway.** `main` had
`required_status_checks.strict = true` ("require branches to be up to date before merging").
GitHub's auto-merge never updates a pull request branch: it waits for every merge requirement to
be satisfied and will not satisfy that one for you. So an armed pull request that fell behind
waited on a condition nothing in the system would ever produce. At this repo's merge rate every
armed pull request reached that state within the hour. The failure is silent in the worst way,
because the pull request page shows a full column of green checks and an armed merge.

`strict` was not gratuitous. `operating-skills-version-check.yml` named it as the load-bearing
setting keeping that guard honest: `on: pull_request` does not re-fire when the base branch
moves, so a run that was green at base=5 / head=6 stays green after another pull request takes 6,
which is precisely the DOR-509 hole reopened by timing rather than arithmetic. Any replacement
for `strict` has to re-evaluate that guard against the base branch's real tip before the merge
lands.

## Decision

**The merge queue replaces `strict`.** GitHub builds each queued pull request on top of `main`
plus everything ahead of it in the queue, runs the required checks against that combined tree,
and fast-forwards only if they pass. That is the guarantee `strict` was approximating, without
anyone updating a branch, and it is available at no cost because this is an organization-owned
public repository. `required_status_checks.strict` goes to `false`; branch currency stops being a
concept authors or agents have to think about.

This is strictly stronger than what it replaces, which is why the `strict` dependency in
`operating-skills-version-check.yml` is discharged rather than merely moved. `strict` only
guaranteed the branch was current when the author last updated it, and the base could still move
between that re-run and the merge. The queue re-runs against `merge_group.base_sha`, the exact
commit the merge will sit on, with nothing able to land in between.

**Every required check reports on `merge_group`.** A required check that never reports on a merge
group blocks the queue forever, so this is a hard prerequisite and lands first, separately, while
the queue is still off.

**Policy checks stay decided at pull request time.** Fragment coverage depends on the pull
request's labels and number. The `merge_group` payload carries neither, and the only place they
appear is the `gh-readonly-queue/...` ref format, which GitHub explicitly does not treat as API
contract. We will not put a policy gate on a string GitHub does not promise. Coverage is
therefore answered before queueing and not re-asked; fragment _validity_, which needs only two
commits, does re-run in the queue against the real base.

**Arming a merge becomes an owned, automated step.** `merge-tail.yml` arms auto-merge on pull
requests that are finished, every ten minutes. Its decision lives in
`scripts/should-arm-automerge.sh` and is affirmative rather than permissive: unknown, unsettled
or unreadable is always a refusal. It does not update branches, because the queue removes the
need and because a branch update pushed with `GITHUB_TOKEN` creates its `synchronize` run in an
approval-required state, which would trade one deadlock for another.

**The queue starts at batch size 1.** One pull request per merge group keeps pull request
identity unambiguous and costs nothing at the current rate: required checks settle in about five
minutes, which sustains roughly twelve merges an hour against an observed 2.5. Batching is a
throughput optimization to reach for when that stops being true, not a default.

## Consequences

### Positive

- Branch currency stops existing as work. No agent or human updates a branch to satisfy a gate again.
- The `#488`/`#489` class becomes catchable. Two pull requests each green alone against the base
  they branched from, red once combined, is invisible to any `pull_request` run by construction.
  The queue tests the combined tree, which is the first thing in this repo that structurally can.
- The parallel-version-bump collision that `operating-skills-version-check.yml` warns about now
  fails in the queue instead of shipping silently.
- Finishing a pull request and landing it stop being different jobs, so a green reviewed branch
  no longer depends on somebody noticing it.

### Negative

- A merge armed by `merge-tail.yml` does not trigger the `push: main` workflows, because GitHub
  suppresses downstream runs for anything `GITHUB_TOKEN` triggers. While `strict` was on those
  runs re-tested an already-tested tree, so the real loss is turbo cache warming from `main`. The
  escape hatch is a `repo`-scoped PAT, deliberately declined to avoid provisioning a credential
  for code the queue makes unnecessary.
- Two guards now depend on the queue staying on. `version-outranks-base` needs `merge_group` in
  its `on:` list and needs to stay a required check; if the queue is ever removed, `strict` has to
  come back or that guard silently regains its hole.
- Fragment coverage is no longer re-checked at merge time. This is safe only because a pull
  request cannot enter the queue until its required checks have passed on the pull request, and
  neither its label nor its diff can change afterwards. That premise is load-bearing.
- An automated arming step lands code without a human at the moment of merge. The review gate
  still governs what may be armed, but the gate is now a script, and a refusal in it that quietly
  stops matching would not crash: it would keep returning `ARM`. Hence the fixture suite, and
  hence bending one field of a known-good pull request per case so a failure names the field.

## Notes

`strict` is documented as load-bearing in exactly one place, and that comment was rewritten in
the same change that added `merge_group`, not afterwards. A migration that leaves behind a
comment asserting the old invariant is how the next person reintroduces the hole on purpose.

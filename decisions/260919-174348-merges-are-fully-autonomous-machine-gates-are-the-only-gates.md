---
id: 260919-174348
title: Merges are fully autonomous; machine gates are the only gates
status: accepted
created: 2026-09-19
spec: null
superseded-by: null
---

# 260919-174348. Merges are fully autonomous; machine gates are the only gates

## Status

Accepted (operator decision, 2026-09-19). Builds on
[260728-112203](260728-112203-merge-queue-replaces-branch-currency.md), which made arming a
merge an automated job; this ADR states the policy that ADR's mechanism already implied.

## Context

About 780 PRs a month merge into `main`, almost all written by agents, and no rule requires a
human to approve any of them: `main` requires 9 status checks and no review, conversation
resolution is off, and merge-tail arms finished PRs every 10 minutes. The `/flow` "human gate"
is a convention, not a control. At that volume a human approval step would either become the
bottleneck or a rubber stamp. Meanwhile the review that does exist cannot block: 58% of its
real Important findings merged unfixed. Every agent also runs as the operator's GitHub account,
which holds the admin role, so a single `--admin` merge can skip every check.

## Decision

We will keep merges fully autonomous, with no human approval before merge, ever, and put all
quality control in machine gates that run on every PR and every merge group. Concretely:

- Ruleset 19893973 is the only protection on `main`; its required checks are declared in
  `ci/required-checks.json` and every one must report on both `pull_request` and
  `merge_group` (the deadlock invariant, enforced by the CI Steward census).
- Nothing lands outside the merge queue. Admin bypass is narrowed to `pull_request` (no direct
  pushes, admin included), and a PreToolUse guard refuses admin merges; the only sanctioned
  admin merge will be the mechanically bounded break-glass path of CI Steward phase 1b, backed
  by a server-side detector and automatic revert.
- No admin credential lives in GitHub Actions, so no automated change can edit the ruleset or
  un-require a check. Phase 0 replaces the one exception, the admin-account PAT
  `MERGE_TAIL_TOKEN`, with the `dorkos-merge-tail` GitHub App (no Administration); the
  old secret is deleted right after that PR merges.
- The Claude review becomes a blocking machine gate (a required `review-gate` job, red on an
  open Important finding) in phase 2, on the existing subscription, with no paid reviewer.

## Consequences

### Positive

- Throughput is bounded by machine time, not by a person's attention, which is the premise of
  the product ("one person ships like a team").
- The pipeline's job is explicit: it is the only line of defence, so its gaps become defects to
  fix rather than risks a reviewer might catch.
- The one command that could skip every gate (`--admin`) has a guard now and a server-side
  fence later.

### Negative

- A defect no machine gate can see (layout, CSS, Electron timing, a wrong assumption about an
  outside tool) reaches `main` unseen. Of 12 traced escapes, the review saw the defective code
  in 10 and flagged 1; those are testing gaps, recorded as seeded experiments.
- The review gate draws on the same subscription limits as the agents that write the code, so
  it needs fail-closed and review-debt rules (phase 2) rather than a simple "required".
- The PreToolUse guard reads command text only. A script on disk, `curl` with a token, or a
  harness that does not run the hook walks past it until the phase 1b fence exists.

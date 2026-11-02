---
id: 261102-173111
title: security-review is judged only for PRs into main, by main's own copy
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-review-initialize.initialize
prs: []
ratchet-release: []
field-changes: []
---

## Why

Security found a hole in #3426's verdict job (#dorkos, 2026-11-02 17:25Z). `pull_request_target` had no branch filter and checked out `base.sha`. A PR aimed at any other branch ran that branch's `security-verdict.mjs` with `statuses: write`, so a branch carrying an edited script could write `security-review: success` on the PR's head. An old base was the same hole in time: a PR opened before a rule landed was judged without it.

## What changes

The `initialize` job runs only on `pull_request_target` for `branches: [main]`, and checks out `refs/heads/main` instead of `base.sha`. The script writes `failure`, "base is not main", for a PR whose base is not main, in the event or on a re-read. The `merge_group` job is unchanged.

## Hypothesis

`security-review: success` statuses written by a verdict run for a PR whose base is not main go from possible to 0 over the 14 days after merge. QA reads it by hand from the job logs; no collector metric covers it yet.

## Not fixed here

A branch that rewrites this workflow file can still drop the filter for PRs into it. That is the forging residual #3426 names, and only the Security App closes it.

Revert if a PR into main stops getting a `security-review` verdict.

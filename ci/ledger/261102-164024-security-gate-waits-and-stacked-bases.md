---
id: 261102-164024
title: security-gate waits instead of failing on a PR that is only unlabelled, and re-runs when a stacked layer's base moves
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
prs: []
ratchet-release: []
field-changes: []
---

## Why

Two things made `security-gate` red when nothing was wrong, so lanes learned to ignore it.

- **Every security PR was red until Security labelled it** (Security's required-checks write-up, 2026-11-02, step 4). Since #3426, main's copy writes the `security-review` verdict, so the PR's own check does not need to block.
- **Every stacked layer above the bottom was red** with `PR #N base moved` (DOR-3680). A layer's base is its parent branch, which moves whenever the parent is pushed, so its label was never checked.

## What changes

On `pull_request`, an open PR waits instead of failing when `security-reviewed` was never put on, or when a fresh one is on and a P0 path still lacks `security-deep-reviewed`. The log says "Waiting for Security", and main's `security-review` still refuses the PR. These still fail: a stale label, a label a bot added, a label added after the merge, `hold`, and a merged or closed PR with no label. `merge_group` never waits.

A base that moves mid-run starts the run over on the new base, reading the files again, up to three times. A head that moves still refuses.

## Hypothesis

`security-gate` failures on open PRs whose only problem is a missing label, or `base moved`, go from most security PRs before review to 0 over the 14 days after merge. QA counts it by hand from the job logs; no collector metric covers it yet.

## Not fixed here

`security-review` is still not required, and must not be until the Security App exists (#3426's condition). Until then `arm.sh` refuses unlabelled PRs on its own. DOR-3679's merge-tail arms on `security-gate` passing, so the DOR-3686 PR, which makes it read `security-review` instead, must merge before this one.

Revert if an unlabelled or stale-labelled PR reaches the queue with `security-gate` green and nothing else stops it.

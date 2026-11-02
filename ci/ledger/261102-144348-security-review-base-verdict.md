---
id: 261102-144348
title: security-review is decided by main's copy of the gate, on every label and push, and on the merge queue's own SHA
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-review-initialize.initialize
  - wf.security-review-initialize.merge-group
prs: []
ratchet-release: []
field-changes: []
---

## Why

Security's required-checks write-up (2026-11-02) names two ways the gate can be fooled. A PR edits the gate that judges it, because `security-gate` runs the PR's own copy. Or a PR adds a workflow with `statuses: write` and posts `security-review: success` itself. Meanwhile `security-review` decided nothing: #3407 merged with it still `pending`, since in label mode nothing ever wrote `success`.

## What changes

`security-review-initialize.yml` already ran main's copy from `pull_request_target`. Its job now writes the verdict as well as the initial status: `success` when `security-reviewed` (and `security-deep-reviewed` on a P0 path) is newer than the head's last push, from a person, with no `hold`; `failure` otherwise, naming why. It runs on `opened`, `reopened`, `synchronize`, `edited`, `labeled` and `unlabeled`, one run at a time per PR, so the newest event decides. A new `merge-group` job judges every queued PR from main's lists and posts the verdict on the merge group's own SHA, so a required `security-review` never waits on "expected".

Until the Security App exists, any workflow file a PR adds or changes that grants `statuses: write`, `checks: write` or `write-all` also needs `security-deep-reviewed`. Only one workflow on main grants it today, this one, and it runs main's copy. A PR that edits a file that judges it (`security-review-initialize.yml`, `security-gate.yml` or a `.github/scripts/security-*` script) also needs `security-deep-reviewed`: in the queue the workflow file comes from the merge commit, so it could rewrite its own judge. It fails on its own head, before `arm.sh` can queue it.

The script is `.github/scripts/security-verdict.mjs`. It checks out only the base commit and reads the PR through the API as data. `security-gate`, the labels' meaning and who may add them are unchanged. One job writes `security-review`, so no second writer can overwrite a verdict with `pending`.

## Hypothesis

Security-path PRs that merge while their head's `security-review` is not `success` go from at least 1 (#3407, 2026-11-01) to 0 over the 14 days after Dorian adds `security-review` to the `main` ruleset. QA counts it by hand from merged PRs' statuses; no collector metric covers it yet.

## Not fixed here

On `merge_group`, the workflow file comes from the merge commit, which includes the PR. Only pinning the check's source to main in the ruleset closes that, and that is Dorian's step. One shared token still means a person-only label says who clicked, not who reviewed (Security's item 22).

Revert if a correctly labelled PR is refused by the verdict, or the queue stalls waiting on `security-review`.

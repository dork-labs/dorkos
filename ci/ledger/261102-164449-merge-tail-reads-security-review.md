---
id: 261102-164449
title: merge-tail arms only when main's security-review is success at the head
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.merge-tail.arm
prs: []
ratchet-release: []
field-changes: []
---

## Why

DOR-3679 (#3427) made merge-tail arm only a PR whose `security-gate` check passed at its head. But `security-gate` runs the PR's own copy, so a PR that edits the gate passes its own check (route 1 in Security's required-checks write-up, 2026-11-02). Once `security-gate` waits instead of failing on an unlabelled PR, it is green there too. `security-review` sat `pending` on open PRs, so the generic in-flight rule also stopped merge-tail from arming anything (DOR-3686).

## What changes

`scripts/should-arm-automerge.sh` also requires the `security-review` commit status, which main's copy writes from `pull_request_target` (#3426), to be `success` at the head. Pending, failure, cancelled, skipped, or no row at all is `SKIP security-review-not-passed`. The rule runs before the generic bucket rules, so a pending verdict is never read as a check in flight. The `security-gate` rule from #3427 stays.

## Hypothesis

merge-tail arms 0 security-path PRs whose head's `security-review` is not `success`, over the 14 days after merge-tail is switched back on. QA counts it by hand from the merge-tail run logs and the armed PRs' statuses; no collector metric covers it yet.

## Not fixed here

A workflow a PR adds can still forge `security-review: success` until the Security App exists (#3426's condition), so `arm.sh` stays the arming path and merge-tail stays off until Security says otherwise.

Revert if merge-tail stops arming PRs whose `security-review` is `success`.

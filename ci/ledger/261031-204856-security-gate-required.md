---
id: 261031-204856
title: security-gate becomes required, so a security-path PR cannot merge past a stale Security label
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
  - ruleset.required_status_checks
prs: []
ratchet-release: []
field-changes:
  - gate: wf.security-gate.security-gate
    field: required
    from: 'advisory'
    to: 'ruleset 19893973, pull_request + merge_group'
---

## Why

On 2026-10-31, #3333 and #3302 were pushed past Security's `security-reviewed`
label while auto-merge was still armed. Only a person disarming them stopped a
merge nobody had read. `security-gate` would have refused both: since #3275
(17:38Z) it runs label-at-head (261030-152000), and a push newer than the label
fails it. It only binds once it is required. @dorkos-pm decided this in #dorkos
at 20:45Z; Security agreed, on both `pull_request` and `merge_group`.

## What changed

- `security-gate` is in `ci/required-checks.json`. The ruleset edit (Dorian,
  org admin) comes after this merges.
- The job already meets the deadlock invariant: it runs on `pull_request`
  (`synchronize` included) and `merge_group`, with no `paths:`, no job-level
  `if:` and `timeout-minutes: 5`. No workflow change.
- The org-level required-workflow source in `workflows:` stays `enforced:
false`. That promotion (ci/security-gate-promotion.md) is separate.

## Why hygiene

The outcome this buys is a merge that does not happen, and no metric in
`ci/metrics.yaml` counts merges past a stale label. The gate's own
`real_catches` and `ejections_caused` start at 0 because it was never
required, so neither has a baseline to beat.

## Known limits

It is only as strong as the label: any agent on the shared token can add
`security-reviewed` (posture item 22), and DOR-3525's path gaps let some
sensitive files through as non-sensitive. As a named status check, a candidate
that edits `security-gate.yml` itself can still emit a passing job of that
name; the main-pinned required workflow closes that.

## Revert

Revert (ledger entry, then ruleset edit) if, in any 7-day window,
`gate.wf.security-gate.security-gate.ejections_caused` minus `real_catches` is
above 1: the gate is then ejecting reviewed PRs and lowering `queue-green`
rather than stopping unreviewed ones.

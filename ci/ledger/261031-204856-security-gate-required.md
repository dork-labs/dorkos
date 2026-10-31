---
id: 261031-204856
title: security-gate becomes a required workflow from main, so a security-path PR cannot merge past a stale Security label
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
prs: [3370]
ratchet-release: []
field-changes:
  - gate: wf.security-gate.security-gate
    field: required
    from: 'advisory'
    to: 'org required-workflow rule "DorkOS security gate from main", .github/workflows/security-gate.yml at refs/heads/main, no bypass actors, pull_request + merge_group'
---

## Why

On 2026-10-31, #3333 and #3302 were pushed past Security's `security-reviewed`
label while auto-merge was still armed. Only a person disarming them stopped a
merge nobody had read. `security-gate` would have refused both: since #3275
(17:38Z) it runs label-at-head (261030-152000), and a push newer than the label
fails it. It only binds once it is required. @dorkos-pm decided this in #dorkos
at 20:45Z; Security agreed, on both `pull_request` and `merge_group`.

## What changes, in order

1. This entry lands first (rule 5). `ci/required-checks.json` already declares
   the target in `workflows:`: "DorkOS security gate from main", the workflow
   at `refs/heads/main`, empty bypass list, `enforced: false`.
2. Dorian switches on the organization rule with exactly those settings.
3. A follow-up PR flips `enforced` to `true` once `pnpm ci:census --live`
   sees the rule active.

`security-gate` is **not** added to `contexts`. A named status check can be
satisfied by a candidate that rewrites `security-gate.yml` to emit a passing
job of that name; GitHub picks a required workflow from main before candidate
YAML runs (ci/security-gate-promotion.md). No workflow change: the job runs on
`pull_request` (`synchronize` included) and `merge_group`, with no `paths:`, no
job-level `if:` and `timeout-minutes: 5`.

## Why hygiene

The outcome this buys is a merge that does not happen, and no metric in
`ci/metrics.yaml` counts merges past a stale label. The gate's own
`real_catches` and `ejections_caused` start at 0 because it was never
required, so neither has a baseline to beat.

## Known limits

It is only as strong as the label: any agent on the shared token can add
`security-reviewed` (posture item 22), and DOR-3525's path gaps let some
sensitive files through as non-sensitive.

## Revert

Revert (ledger entry, then the org rule) if, in any 7-day window,
`gate.wf.security-gate.security-gate.ejections_caused` minus `real_catches` is
above 1: the gate is then ejecting reviewed PRs and lowering `queue-green`
rather than stopping unreviewed ones.

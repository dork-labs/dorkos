---
id: 261113-233549
title: Security gate refuses a Security label that went on before the last required check finished
kind: hygiene
status: proposed
actor: agent
gates: [wf.security-gate.security-gate]
prs: []
ratchet-release: []
field-changes: []
---

Hand labels went on while `test` or `browser-test` was still running, three times on
Nov 8 (DOR-3996). `arm.sh` already refuses that locally; this is the CI half. In
label-at-head mode, `security-reviewed` (and `security-deep-reviewed` on a P0 path)
must now be newer than the last required check to finish at the PR head, as well as
newer than the head's last push.

The required names are read from the `main: merge queue` ruleset by name, so a
re-created ruleset refuses instead of reading nothing. Each one is read from check
runs and commit statuses; one not reported, not finished or not passed refuses. The
three that re-run on every label event cannot date a label and are left out; a
fixture test keeps that list equal to the label-triggered required checks.

A check re-run after the label is refused when the PR enters the merge queue, where
every queued PR is judged again. A `check_suite` trigger can't do it: GitHub never
starts workflows for check suites that Actions created.

The workflow only gains `checks: read`. No required check, retry, shard or timeout
changes, and the gate stays not required, so no metric in `ci/metrics.yaml` can move
yet. Revert if the hosted token can't read the ruleset or check runs: the gate then
refuses every security path, the same red as a missing label.

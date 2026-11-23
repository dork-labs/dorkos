---
id: 261124-003500
title: pr-gates is a required check, so PRs auto-merge at open once Security signs off
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.pr-gates.pr-gates
prs: []
ratchet-release: []
field-changes: []
---

DOR-5119, under DOR-5098. `pr-gates` (Security-only since #4188) went green end to end on #4191
and #4192 (red at open, re-run green by security-verdict.yml after the cloud Security pass), and
green on merge-group entries. ci-steward added it to ruleset 19893973 on Nov 24 (delegated by
Dorian, Nov 23; backup taken first). This syncs `ci/required-checks.json` and the lists that mirror
it. With all three of `not-held`, `release-window` and `pr-gates` required on main,
`open-pr.sh` turns on auto-merge when a PR opens.

`pr-gates` re-runs on label events, so it joins LABEL_RERUN_CONTEXTS: it cannot date a Security
label. The daily canary skips it, as main has no pull request.

Baseline (Nov 23): 0 PRs auto-merged at open; every merge was a person's click.
Target: PRs opened with open-pr.sh merge with no click once their checks and Security are green.
Evaluate: Nov 30.

Revert (drop it from the ruleset, then this file) if a PR with a failing Security verdict merges,
or if PRs wait on pr-gates with a cloud pass and no re-run.

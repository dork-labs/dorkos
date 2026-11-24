---
id: 261124-115201
title: Re-run every unpassed pr-gates run on a head after a Security pass, not only the newest
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-verdict.security-verdict
prs: []
ratchet-release: []
field-changes: []
---

`pr-gates` runs on every PR event, so a new PR gets 2 to 4 runs within seconds (opened, then one
per label `open-pr.sh` adds), all before the cloud review finishes, all red. After a Security pass,
`security-verdict.yml` re-ran only the newest finished run. GitHub merges on the newest check run,
so the PR was mergeable, but the older reds stayed on the PR and read as a failing PR (#4219, #4225,
#4233, #4237 to #4239 on Nov 24 all showed FAILURE, FAILURE, FAILURE, SUCCESS).

Now a pass re-runs every finished `pr-gates` run on that head that did not pass, newest first, at
most 6, best effort. Not chosen: a cancelling `concurrency:` group in `pr-gates.yml`. It would
leave cancelled checks on the PR instead of reds, and `pr-gates.yml` deliberately has none so each
run reads the PR live. `merge_group` runs are untouched.

Baseline (Nov 24): all 6 PRs above had a cloud pass and still showed 3 red `pr-gates` runs.
Target: no PR whose head has a cloud pass shows a red `pr-gates` run, with no push needed.
Evaluate: Nov 26, over the PRs opened after this merges.

Revert if a re-run loops, or the extra re-runs hit the API rate limit.

---
id: 261123-235000
title: open-pr.sh turns on auto-merge at open, once main requires not-held, release-window and pr-gates
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-5107, the end state of DOR-5098: once a PR is open, nobody arms it. `scripts/open-pr.sh` runs
`gh pr merge --auto` after opening, so GitHub merges the PR as soon as every required check is
green. A green PR waits for nobody.

It only does that when it is safe, and the script checks this itself rather than leaving it to a
brief:

- the PR is not a draft and was not opened with `--hold`;
- main's `ci/required-checks.json`, read from `origin/main` and never from the branch, already
  requires `not-held` (#4163), `release-window` (#4164) and `pr-gates` (#4166).

Those three checks make a hold, a freeze or release, and a missing Security, QA or design sign-off
block the merge by themselves. Until the ruleset requires them, nothing changes and the script says
why (`auto-merge: off: ...`). The day they become required, it switches on. It is pinned by 16 new
fixtures in `scripts/test-open-pr.sh`.

Not covered here: re-arming a PR that the queue takes back out. merge-tail, disabled since Nov 18,
is that backstop, and it becomes safe to re-enable once the three checks are required.

Hygiene for now: its metric, `tracked.green-to-armed` (baseline p50 21.4 min over 117 merges,
Nov 17–19; target 0, since auto-merge makes the two the same moment), is not computed by the
collector yet. Revert if a PR merges past a hold, freeze or missing sign-off, or if auto-merged PRs are ejected
from the queue more often than hand-armed ones.

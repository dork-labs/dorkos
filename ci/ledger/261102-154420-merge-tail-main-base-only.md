---
id: 261102-154420
title: merge-tail arms only a PR into main whose security gate passed at its head
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.merge-tail.arm
prs: []
ratchet-release: []
field-changes: []
---

`scripts/should-arm-automerge.sh` never read a PR's base. A stacked layer targets another PR's branch, which has no merge queue, so arming it merged it there on the spot once it was green, and it then rode into main with its parent, past its own review and label. #3150 merged into #3148's branch that way on 2026-10-23 (DOR-3679). The gate now arms only `baseRefName == "main"`, and refuses a payload without the field. merge-tail reads it with the rest of the PR (one more field on its existing `gh pr view`).

It also requires the `security-gate` check to pass at the head, by name. That job is the one place Security's label rule lives (`security-reviewed` added after the last push, on a security path), and its ruleset is not enforced yet, so nothing else stopped the queue merging a PR whose label predates its head. No row arms nothing.

No new call, step or check. Every new refusal is pinned in both directions by `scripts/test-should-arm-automerge.sh`, and the old gate fails 10 of them. Revert if merge-tail stops arming green PRs into main.

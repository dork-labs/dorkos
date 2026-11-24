---
id: 261124-131739
title: The CI guide and PR skill say the full browser suite runs on main after merge
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Docs only. Since #4231 (DOR-5130, ledger `261124-014413`) merge-queue entries run the scoped @smoke
shards and the full browser suite plus first-run run on main after every merge, the canary and
release PRs. `contributing/ci.md` and the creating-pull-requests skill still said the full browser
suite ran only in the queue, and told agents to read an ejection on that basis. Nothing measurable
should move; revert only if #4231 itself is reverted.

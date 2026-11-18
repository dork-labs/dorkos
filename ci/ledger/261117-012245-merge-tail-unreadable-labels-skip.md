---
id: 261117-012245
title: 'merge-tail: unreadable labels, and every other unreadable field, mean skip'
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.merge-tail.arm
prs: [3881]
ratchet-release: []
field-changes: []
---

DOR-3871. `should-arm-automerge.sh` read absent or null `labels` as "no labels", so a
partial or garbled answer from GitHub read a PR on `hold` as unheld and could arm it.
merge-tail has been off since the 0.135.9 freeze for this. Labels that are absent, null,
not a list, or carry an entry that is neither a string nor an object with a string name
are now `SKIP labels-unreadable`, checked just before the hold.

The same shape is closed for the other fields the gate reads: `isDraft` not a boolean
(`draft-unknown`), `autoMergeRequest` absent (`auto-merge-unknown`), `mergeStateStatus`
not a string (`mergeability-unknown`), `reviewDecision` absent or not null/string
(`review-decision-unknown`; null stays an answer, GitHub's for "no review required"),
a negative thread count (`review-threads-unknown`), `checks` absent, null, not a list or
with a non-object row (`checks-unreadable`), a bucket outside pass/skipping/fail/pending/
cancel or missing (`checks-state-unknown`), and a queue removal that names failed checks
with no readable time or a `failedChecks` that is not a list (`queue-history-unknown`).
Every new branch is pinned in `test-should-arm-automerge.sh`; 27 of the new cases fail
against the previous gate, 17 of them as ARM.

No workflow, trigger or permission changed. Revert if a fully green, unheld PR built by
`should-arm-automerge-input.sh` from a real GitHub answer is skipped by one of these slugs.

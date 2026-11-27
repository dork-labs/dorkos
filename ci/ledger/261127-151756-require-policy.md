---
id: 261127-151756
title: typecheck.yml's policy job is a required check (DOR-4949, stage 2)
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.typecheck.policy
prs: []
ratchet-release: []
field-changes: []
---

Stage 2 of ledger 261126-231130. `policy` runs the policy gates on their own, with
`typecheck`'s triggers and no path filter (#4548). It reported green on 15 of 15
merge-queue builds before this change. This adds it to `ci/required-checks.json`,
with one census-allowlist entry: its ledger-coverage step runs on pull_request
only, for the same reason as `typecheck`'s copy. The person's step follows after
merge: add the status check `policy` (GitHub Actions) to ruleset 19893973
("main: merge queue"), beside `typecheck`. Stage 3 then removes the copied steps
from `typecheck`. Revert if `policy` blocks a PR that cannot reach it.

---
id: 261123-235500
title: pr-gates checks Security only, and a cloud Security pass re-runs it
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.pr-gates.pr-gates
  - wf.security-verdict.security-verdict
prs: []
ratchet-release: []
field-changes: []
---

Dorian, Nov 23 (DOR-5119): release fast, fix forward. No local agent reviews an open PR, so QA's
`qa-real-data` and the designer's `design-ok` stop being merge gates; QA and the designer sweep
each day's merges instead (DOR-5120). `pr-gates` now blocks only on Security's sign-off: the
`security-reviewed` label after the head, or a passing cloud `security-verdict`. The QA and design
reasons are still printed as notes.

`pr-gates` runs on PR events, usually before the cloud review finishes, so on Nov 23 it was red on
every PR even after the cloud lens passed (#4180, #4184, #4185, #4186). `security-verdict.yml` now
re-runs that head's newest finished `pr-gates` run after a pass.

Baseline (Nov 23): `pr-gates` green on 0 of the last 5 PRs, though 4 had a cloud pass.
Target: green on every PR whose head has a cloud pass, with no push needed. Then `pr-gates`
becomes required and `open-pr.sh` turns on auto-merge at open.
Evaluate: Nov 25, over the PRs opened after this merges.

Revert if a PR merges with a Security Must open, or if the re-run loops.

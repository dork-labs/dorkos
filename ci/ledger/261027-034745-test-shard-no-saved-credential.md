---
id: 261027-034745
title: The test shards check out without a saved credential
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: [3217]
ratchet-release: []
field-changes: []
---

`test-shard` now checks out with `persist-credentials: false`, as `security-gate`,
`security-review-initialize`, `ci-steward` and others already do. Nothing in the
job pushes or fetches after checkout.

Why: the checkout action saves its credential into the checkout's own git
settings, as an include. The server suite reads this checkout as a project, and
DOR-3343's audited git runner (#3216) refuses a repository whose settings include
another file, so with the credential saved those tests go red. Without it, the
checkout's settings are the plain ones every clone has, and the token stays out
of reach of the code the suite runs.

This is a hygiene change: it claims no speed or flake improvement. Revert only
if a later step in the job needs authenticated git, and then pass the token to
that step alone.

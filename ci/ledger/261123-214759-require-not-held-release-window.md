---
id: 261123-214759
title: not-held and release-window become required checks
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.not-held.not-held
  - wf.release-window.release-window
prs: []
ratchet-release: []
field-changes: []
---

Part of DOR-5098. Dorian handed ci-steward the ruleset step on Nov 23. `not-held` (#4163) and
`release-window` (#4169) were added to ruleset 19893973's required checks on 2026-11-23 at about
21:45Z, and this file now matches it.

Evidence before turning them on: each passed all 10 merge-queue runs since it landed. On pull
requests, the only red runs were on their own branches before they merged, when main did not have
the script yet.

`pr-gates` is not required yet. It is red on every queue entry merged while arm-door was paused,
because those PRs lacked Security's or QA's labels. Requiring it enforces the sign-off rule in the
queue, so it waits until sign-offs are flowing.

Revert if either check goes red on a PR that is not held, frozen or behind a release, or fails to
report on a merge-queue entry. To revert, remove the two contexts from the ruleset and from this
file.

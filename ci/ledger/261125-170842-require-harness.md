---
id: 261125-170842
title: scripts-test's harness job is a required check
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.scripts-test.harness
prs: []
ratchet-release: []
field-changes: []
---

Nov 25 (t8): `harness` (repo-wide vitest suites and the shell suites marked for the harness lane) was not required, so
a PR red on it could merge and break main's harness; the API lead's #4396 nearly did. #4398 made it requirable: it
reports on every PR and queue entry, the queue skips it when the entry cannot reach it or the PR head already passed
it, and any doubt runs it. It then reported green on 12 merge-queue builds before this change. This adds it to
`ci/required-checks.json` with its two census-allowlist entries (the job's scope condition, and the main-only pnpm
store save its siblings carry); ruleset 19893973 follows after merge. Revert if it blocks a PR that cannot reach it.

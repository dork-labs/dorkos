---
id: 261125-024810
title: The agent release notes stamper and its repo-wide suite
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Row 5 of the daily-release design (DOR-5123): `scripts/release/stamp-release-notes.ts` stamps
the agent release notes a release shipped, for the back-merge. No workflow runs it yet;
ci-steward's `daily-release.yml` will.

Its suite reads the server's `agent-release-notes.ts`, so it goes on `REPO_WIDE_SUITES` in
`scripts/vitest.repo.config.ts` (a change to that file's shape can turn it red from outside
`scripts/`). No gate's retries, shards, timeout or required status changes, and no metric
should move, so this is hygiene. Revert the list entry if it makes `typecheck` slow or flaky;
the suite runs in under a second.

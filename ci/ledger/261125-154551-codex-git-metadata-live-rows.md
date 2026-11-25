---
id: 261125-154551
title: Codex binary suites gain a git-metadata row and share one raw app-server fixture
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4542. A new `git-metadata.binary.test.ts` (run by the `codex-sandbox`
job on Linux and `codex-binary-macos` on macOS) checks that a bracketed folder
and a dangling worktree start Codex with Git files protected below Full. The
raw app-server setup that `default-permissions.binary.test.ts` carried moved to
a shared `fixtures/raw-app-server.ts`, so both suites drive the binary the same
way. One more file in an existing job: no new job, and a small run-time
increase. Revert if the new row turns flaky on the Linux runner, where it hasn't
run before this PR.

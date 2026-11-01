---
id: 261101-123406
title: Pin the worktree janitor's unplugged-disk guard in the fixtures job too
kind: hygiene
status: active
actor: agent
gates:
  - wf.scripts-test.fixtures
prs: []
ratchet-release: []
field-changes: []
---

Entry 261031-010157 made `scripts/worktree-janitor.sh --fix` skip
`git worktree prune` while a worktree's `/Volumes/<name>` disk is missing, and
pinned it with a vitest suite in the `harness` job.

This entry adds a second, shell-level pin in the required `fixtures` job:
`bash scripts/test-worktree-janitor-volumes.sh`, plus the matching link in
`test:scripts` that the shell-suite parity test demands. It drives the real
script end to end from bash, the way the LaunchAgent does, and adds a case the
vitest suite lacks: a missing-disk worktree beside one that vanished from the
internal disk, where nothing is pruned. The suite is hermetic (throwaway repos and a bare origin in a temp dir, a fake
`gh`) and takes a few seconds. Nothing in CI measures the outcome on the
operator's Mac, so it is written here rather than as a hypothesis.

No required check, deadline, shard, retry or coverage rule changes. Revert by
removing the step and the `test:scripts` link together.

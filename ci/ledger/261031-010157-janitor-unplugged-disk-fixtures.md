---
id: 261031-010157
title: Pin the worktree janitor's unplugged-disk guard in the fixtures job
kind: hygiene
status: active
actor: agent
gates:
  - wf.scripts-test.fixtures
prs: []
ratchet-release: []
field-changes: []
---

Worktrees are about to live on an external disk under `/Volumes/<name>/`. When
that disk is unplugged, git sees each of those worktrees as one whose directory
is gone, and `git worktree prune` deletes their records. The work stays on the
disk, but the repo no longer knows it is there. `scripts/worktree-janitor.sh
--fix` runs that prune every night from the operator's LaunchAgent.

The janitor now checks every path in `git worktree list --porcelain` first. If
one sits on a `/Volumes/<name>` that is not mounted, `--fix` removes nothing and
prunes nothing in that repo, and prints one line per missing disk. Worktrees
whose directory vanished from the internal disk are pruned as before.

This entry adds one step to the required `fixtures` job,
`bash scripts/test-worktree-janitor-volumes.sh`, and the matching link in
`test:scripts` that the shell-suite parity test demands. The suite is hermetic
(throwaway repos and a bare origin in a temp dir, a fake `gh`) and takes a few
seconds. Against the previous janitor it fails 4 of its 6 checks; the two that
pass pin the unchanged internal-disk behaviour. Nothing in CI measures the
outcome on the operator's Mac, so it is written here rather than as a
hypothesis.

No required check, deadline, shard, retry or coverage rule changes. Revert by
removing the step and the `test:scripts` link together.

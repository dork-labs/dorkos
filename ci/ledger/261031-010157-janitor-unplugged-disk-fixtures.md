---
id: 261031-010157
title: The worktree janitor skips pruning while a worktree's disk is missing
kind: hygiene
status: active
actor: agent
gates:
  - wf.scripts-test.harness
prs: []
ratchet-release: []
field-changes: []
---

Worktrees are about to live on an external disk under `/Volumes/<name>/`. When
that disk is unplugged or asleep, git sees each of those worktrees as one whose
directory is gone, and `git worktree prune` deletes their records. The work
stays on the disk, but the repo no longer knows it is there.
`scripts/worktree-janitor.sh --fix` runs that prune every night from the
operator's LaunchAgent.

The janitor now reads `git worktree list --porcelain` first. A worktree under
`/Volumes/` whose directory is not there is never judged, and neither is its
branch. While any such worktree exists, `--fix` skips `git worktree prune` and
logs one ALERT line per missing disk. Worktrees on disks that are present are
still reaped as before.

Pinned by `scripts/__tests__/worktree-janitor-volumes.test.ts`, which the
existing `Unit tests` step of the `harness` job already runs
(`vitest run --config scripts/vitest.config.ts`), so no workflow or
`test:scripts` line changes. The suite is hermetic (throwaway repos, a bare
origin, a fake `gh`) and takes about 3 seconds. Against the previous janitor it
fails 3 of its 4 cases; the fourth pins the unchanged internal-disk prune.
Nothing in CI measures the outcome on the operator's Mac, so it is written here
rather than as a hypothesis.

No required check, deadline, shard, retry or coverage rule changes. Revert by
reverting the janitor change and deleting the test file together.

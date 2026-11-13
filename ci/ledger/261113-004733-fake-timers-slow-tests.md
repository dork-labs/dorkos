---
id: 261113-004733
title: Three test files wait on a fake clock instead of a real one
kind: experiment
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: []
hypothesis:
  metric: gate.wf.test.test-shard.duration_p90@merge_group
  slo: queue-build
  baseline: 28.32
  baseline_source: 'origin/ci-steward-data snapshots/2026-11-11.json, gates["wf.test.test-shard@merge_group"].durations, 126 samples; nearest-rank p90 1,699 seconds (28.32 minutes).'
  target: 28.32
  after_days: 7
ratchet-release: []
field-changes: []
---

Refs DOR-4190. Codebase Cleanup's CI target is 12 minutes per merge. These
tests sat through real-clock waits: a demo turn's word and tool beats, a room
stream's quiet window and deadline, and a 3-second control bound. They now run
the same steps on vitest's fake timers.

**The direct target is these tests' own time, from CI's per-test reports**
(merge-group runs 43329600786 and 43320486446, identical to 0.4 s):

| File                                                                   | Before (CI) | After (local) |
| ---------------------------------------------------------------------- | ----------- | ------------- |
| `apps/server/.../test-mode/__tests__/demo-workspace-scenarios.test.ts` | 13.5 s      | under 0.1 s   |
| `packages/evals/src/runner/__tests__/room-drive.test.ts`               | 16.6 s      | about 0.1 s   |
| `persistent-dispatch.test.ts`, the one unanswered-mode-change case     | 3.0 s       | under 0.1 s   |

That is about 33 seconds of test time off, down by at least 32 s. The files run
in different shards, so the shard wall time drops by less than that. The scored
metric guards the other side: the unit shards' p90 must not grow. No retries,
shards, timeouts or required checks change.

Revert a file if its tests flake in the queue. `room-drive` still talks over a
real socket and the persistent case still writes real files; both move the
clock on in small steps and give real I/O turns between them. The room-drive
cases passed 125 repeated runs locally at a load near 15.

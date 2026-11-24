---
id: 261124-114526
title: Trial four vitest workers per CI test shard
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: []
ratchet-release: []
field-changes: []
---

DOR-5130. The previous trial (draft #4208, closed) found the test shards' time is dominated by
per-file module import (~2.2 s per apps/server file), the 4-core runners get 3 vitest workers by
default (forks pool, isolation on), and turbo runs one package at a time. Threads were slower and
broke the HOME/chdir-stubbing tests, so they are out. This trial asks for one worker per core:
`VITEST_MAX_WORKERS=4` on the test-shard job's env, CI only. vitest reads the variable over any
config, and it is on turbo's globalPassThroughEnv, so no task hash moves.

Baseline (full suite on six PR shards, #4208): apps/server wall 3,317-3,721 s summed over the six
shards; vitest import 5,314-5,982 s.
Target: apps/server summed wall at least 15% under the baseline's low end (under 2,820 s), with no
new failure, timeout or OOM.
Evaluate: on this draft's PR run (a `.github/` change plans every suite on six shards).

Revert if the shards go red, a worker runs out of heap, or the filesystem-watcher tests
(`access-control`, `relay-gc`) start flaking under the extra worker.

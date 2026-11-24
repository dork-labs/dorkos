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

Results (Nov 24; full suite on six PR shards; sums over the six shards' vitest summaries):

- Same-day baseline, 3 workers (runs 45310028117, 45318208073, 45331754886): apps/server wall
  3,558-4,016 s, import 5,666-6,446 s; apps/client wall 1,776-2,014 s; slowest shard job
  1,363-1,420 s.
- 4 workers (run 45387267533): apps/server wall 3,565 s, import 7,705 s, tests 5,942 s; apps/client
  wall 1,794 s; slowest shard job 1,266 s. All green, no OOM.
- 5 workers (run 45390901689): apps/server wall 3,955 s, import 11,097 s; apps/client wall 1,972 s;
  slowest shard job 1,529 s. Seven tests timed out at 5 s on three shards (canvas doc-channel,
  ProfilePanel, router tests).

Summed import time grows with the worker count, so the shards are CPU-bound. A fourth worker is
within noise on summed wall time and misses the target. Five oversubscribes the runner.

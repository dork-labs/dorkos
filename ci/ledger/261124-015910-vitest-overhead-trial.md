---
id: 261124-015910
title: 'Trial: apps/server unit tests on the threads pool instead of forks'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50@merge_group'
  slo: 'pr-feedback'
  baseline: 22.2
  baseline_source: 'origin/ci-steward-data snapshots/2026-11-22.json, gates["wf.test.test-shard@merge_group"].durations: n=366 job runs, p50 22.2 min.'
  target: 19
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-5130 step 3. Hypothesis: unit-test shard time is dominated by per-file overhead, not test bodies.
The Vitest 4.1.11 summary lines in queue run 45302152018 (ten 4-core shards, three workers each)
split the worker time: apps/server summed `import` 6,323 s, `tests` 5,026 s, `transform` 392 s,
`environment` 0 s over a 3,952 s wall; apps/client `import` 2,897 s, `environment` (jsdom) 1,192 s,
`setup` 316 s, `tests` 1,201 s. Across the run, overhead (import + environment + setup + transform)
is about 12,600 worker-seconds against 7,100 in test bodies. Four green PR runs on six shards
(45299405665, 45296610842, 45279371624, 45278503449) show the same server split: import
5,314-5,982 s, tests 4,158-4,698 s, server wall summed over six shards 3,317-3,721 s.

Vitest 4 starts a new worker for every test file while `isolate` is on (`getPoolRunner` in
vitest's pool), so each server file pays a process spawn plus a full module-graph fetch over IPC.
The change: `pool: 'threads'` in apps/server's vitest config, isolation kept. Ruled out:
`isolate: false` (Vitest 4 skips the module reset between files without isolation, and 938 server
test files call `vi.mock`); a Node compile cache (fork workers are stopped with SIGTERM, so the
cache is never flushed, and external-dependency loading is only about 0.3 s of the 2.2 s per-file
import).

Measure first on the draft PR: apps/server's per-shard `Duration` and the test-shard step time
against the four PR baselines above. Known risk: `process.chdir` is unsupported in worker threads
(isolation-discovery.test.ts). Revert if the threads pool fails tests the forks pool passes, or
does not cut server import time by at least 15%.

---
id: 261015-094830
title: Bound full typecheck concurrency after observed runner memory pressure
kind: incident-fix
status: active
actor: agent
gates:
  - wf.typecheck.typecheck
prs: [2673]
hypothesis:
  metric: 'gate.wf.typecheck.typecheck.failure_rate@pull_request'
  slo: 'pr-feedback'
  baseline: 0.0345
  baseline_source: 'ci-steward-data latest.json date 2026-10-13, collected 2026-10-14T10:01Z, points to snapshots/2026-10-13.json (SHA-256 bccf1cba67d45b450f5ca9de32a750047572faed9f84956635c934497b612643). One-day gate wf.typecheck.typecheck@pull_request: 68 runs, 56 success, 2 failure, 10 cancelled, 0 retried; verdicts.ts failure_rate formula rounds 2/(68-10) to 0.0345. This is a one-day baseline, not a seven-day window. Collector unhealthy solely because a local export was nine days stale; snapshot complete, not partial or truncated.'
  target: 0.01725
  after_days: 7
ratchet-release: []
field-changes: []
---

Hypothesis: limiting the unchanged full typecheck graph to two concurrent tasks
reduces runner memory contention and halves this gate's pull-request failure rate
from 0.0345 to 0.01725 after seven days. The collector's normal before-window and
sample-size rules still decide the verdict; this entry claims no measured win.

## Evidence and scope

On PR #2673 head e13da8e8a7b39b24f9996abe4371b37da2209e5e, typecheck job
116347950296 (run 38712755867) recorded 64 bounded resource samples. On a host
with 16,373,452 KiB total memory, available memory fell to 108,108 KiB while
cgroup usage reached about 14.99 GiB and memory-pressure full avg10 reached
60.88 percent. The runner then sent TERM and reported a shutdown signal after
about five and a half minutes, with 40 of 46 tasks successful and zero cached.
The observed cgroup OOM counters stayed zero. This is evidence of memory
pressure and a reason to test lower concurrency; it does not prove an OOM kill
or establish why the runner shut down.

Only the compiler command gains `--concurrency=2`. The full graph, `--continue`,
8,192 MiB Node heap, 20-minute job timeout, required context, triggers, retries,
and all preceding gates remain unchanged. The bounded resource sampler remains
active so the resulting pressure and completion can be compared.

The maintained sampler fixture now expects the exact new compiler arguments.
Its descriptor regression compares the actual sampler control-pipe identity and
writable access mode, rather than rejecting every high-numbered pipe. The real
wrapper must still return zero and clean up; deliberately omitting one compiler
writer close must return 89 and clean up. All seven test cases and their clocks
remain present. The original Linux failure's specific descriptor is unproven.

## Revert condition

Revert the concurrency change if the unchanged full graph cannot finish within
the existing 20-minute limit, or if observed failures or resource pressure worsen.
Do not extend that timeout or skip tasks to obtain a pass. Investigate a narrower
resource fix instead. The earlier observation-only entry on this gate and other
concurrent changes may confound the verdict; retain that caveat when reading it.

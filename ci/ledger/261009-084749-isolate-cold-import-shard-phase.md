---
id: 261009-084749
title: Run cold import controls after ordinary shard work finishes
kind: incident-fix
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: [2673]
hypothesis:
  metric: gate.wf.test.test-shard.failure_rate@pull_request
  slo: queue-green
  baseline: 0.05142857142857143
  baseline_source: 'ci-steward-data@61a1155540156e8612198eb9e2416054be23a3a9:latest.json -> snapshots/2026-10-07.json gates.wf.test.test-shard@pull_request.conclusions; 18 failed / 350 completed noncancelled (332 successful), 54 cancelled excluded.'
  target: 0.025
  after_days: 7
ratchet-release: []
field-changes: []
---

Current200155 required run37902997014 failed only five original cold-import
controls with SIGTERM at the unchanged five-second deadline and empty stderr.
Two later cold entries passed; seven other shards and both communities passed.
This supports testing a scheduling hypothesis, not a claim that contention was
the measured cause. Preserve this failed run and all original assertions.

Await the existing full/affected ordinary Turbo sweep, excluding only the
whole reservation-bridge file, then run that whole33 file through the same
server task in a second phase. Its seven fresh processes, timeout/load-scaling,
max20/outer22 bounds, worker cap4, native auth and teardown are unchanged.
Package concurrency1, eight shards, PR retry0, original queue retry1/reporting,
required contexts/fan-in and thirty-minute job deadline stay unchanged.
The cold phase runs even after an ordinary failure; both results are retained.
PR affected-server selection comes from the fresh original task summary.

CLI filtering precedes Vitest sharding, so this is a NEW complete partition,
not an assertion that old shard ownership is unchanged. Source simulation of
1698 current server files proves1697 ordinary plus one cold file, no overlap,
complete eight-way union. The singleton cold file belongs to shard1; one
ordinary file moves shard2 to shard1. Other task graphs are retained.
Pure static simulation is not actual native discovery or performance proof.

Genuine ordinary/cold report bodies are retained. Canonical JSON counters and
full failing assertions are composed from disjoint reports; retry records from
both phases survive. Existing quarantine/file-union/report consumers read those
canonical reports. The whole-workspace execution guard explicitly reads the
ordinary summary, not the later server-only summary. Cold phase separately
requires an actual uncached server task and exact collected singleton shard;
empty owner collection cannot pass merely because --passWithNoTests was set.

A second server invocation adds runner startup and may revisit build cache;
no cache equivalence or runtime speedup is claimed. The existing eight-shard
experiment on the same gate can confound the collector verdict. Observe both
job duration/headroom and runner cost; do not label this experiment verified.
Revert or revise if failure_rate misses0.025 in the seven-day after-window,
any discovery/union/affected-selection/report guard fails, cold failures
persist, or duration worsens against the unchanged thirty-minute job budget.

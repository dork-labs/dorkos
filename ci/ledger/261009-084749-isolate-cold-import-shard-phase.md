---
id: 261009-084749
title: Run Room replay and cold import controls after ordinary shard work finishes
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

Actual15ea required run37915819697 passed the isolated cold shard and all
seven fresh cold processes at their original deadlines. Its only test failure
was the unchanged whole Room replay assertion at BODY5000 on ordinary shard6.
No inner Room frontier was observed. This is a scheduling experiment, not
proof that competition caused that timeout or that this proposal repairs it.

Await the existing full/affected ordinary Turbo sweep, excluding only the
whole Room replay and reservation-bridge files. Run whole Room replay next,
then whole33 reservation through the same canonical server task, each only
after the preceding native command closes. Room keeps its body5/setup10 and
owned teardown; cold keeps seven fresh processes, five-second base deadline,
load scaling, max20/outer22, worker cap4, native auth and teardown unchanged.
Package concurrency1, eight shards, PR retry0, original queue retry1/reporting,
required contexts/fan-in and thirty-minute job deadline stay unchanged.
Both isolated phases run even after an ordinary or Room failure; the first
native failure survives. Unknown affected selection refuses expansion with86.
PR affected-server selection comes from the fresh original task summary.

CLI filtering precedes Vitest sharding, so this is a NEW complete partition,
not an assertion that old shard ownership is unchanged. Source simulation of
1698 current server files proves1696 ordinary plus one Room and one cold
file, no overlap, complete eight-way union. Both singleton phases belong to
shard1. Exact ordinary ownership changes are listed in PARTITION-PROOF.json;
old shard ownership is not claimed unchanged. Other task graphs are retained.
Pure static simulation is not actual native discovery or performance proof.

Genuine ordinary/Room/cold report bodies are retained. Canonical JSON counters and
full failing assertions are composed from disjoint reports; retry records from
all three phases survive. Existing quarantine/file-union/report consumers read those
canonical reports. The whole-workspace execution guard explicitly reads the
ordinary summary, not the later server-only summary. Each isolated phase separately
requires an actual uncached server task and exact collected singleton shard;
empty owner collection cannot pass merely because --passWithNoTests was set.

Two additional server invocations add runner startup and may revisit build cache;
no cache equivalence or runtime speedup is claimed. The existing eight-shard
experiment on the same gate can confound the collector verdict. Observe both
job duration/headroom and runner cost; do not label this experiment verified.
Revert or revise if failure_rate misses0.025 in the seven-day after-window,
any discovery/union/affected-selection/report guard fails, Room or cold failures
persist, or duration worsens against the unchanged thirty-minute job budget.

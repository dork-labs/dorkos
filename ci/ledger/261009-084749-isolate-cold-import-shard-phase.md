---
id: 261009-084749
title: Run Room, cold import and checkbox controls after ordinary shard work finishes
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
whole Room replay, reservation-bridge and checkbox-service files. Run whole
Room replay next, then whole33 reservation, then whole56 checkbox through the
same canonical server task, each only
after the preceding native command closes. Room keeps its body5/setup10 and
owned teardown; cold keeps seven fresh processes, five-second base deadline,
load scaling, max20/outer22, worker cap4, native auth and teardown unchanged.
Package concurrency1, eight shards, PR retry0, original queue retry1/reporting,
required contexts/fan-in and thirty-minute job deadline stay unchanged.
All three isolated phases run even after any earlier native failure; the first
native failure survives. Unknown affected selection refuses expansion with86.
PR affected-server selection comes from the fresh original task summary.

CLI filtering precedes Vitest sharding, so this is a NEW complete partition,
not an assertion that old shard ownership is unchanged. Source simulation of
1698 current server files proves1695 ordinary plus one Room, one cold and
one checkbox file, no overlap, complete eight-way union. All singletons belong to
shard1. Exact ordinary ownership changes are listed in PARTITION-PROOF.json;
old shard ownership is not claimed unchanged. Other task graphs are retained.
Pure static simulation is not actual native discovery or performance proof.

Genuine ordinary/Room/cold/checkbox report bodies are retained. Canonical JSON counters and
full failing assertions are composed from disjoint reports; retry records from
all four phases survive. Existing quarantine/file-union/report consumers read those
canonical reports. The whole-workspace execution guard explicitly reads the
ordinary summary, not the later server-only summary. Each isolated phase separately
requires an actual uncached server task and exact collected singleton shard;
empty owner collection cannot pass merely because --passWithNoTests was set.

Three additional server invocations add runner startup and may revisit build cache;
no cache equivalence or runtime speedup is claimed. The existing eight-shard
experiment on the same gate can confound the collector verdict. Observe both
job duration/headroom and runner cost; do not label this experiment verified.
Revert or revise if failure_rate misses0.025 in the seven-day after-window,
any discovery/union/affected-selection/report guard fails, Room, cold or checkbox failures
persist, or duration worsens against the unchanged thirty-minute job budget.

Actual232879 required run37959531540 passed seven shards and both communities,
including the owner shard's existing Room and cold phases. Its sole failure was
the unchanged checkbox-service bounded101-intent recovery case on ordinary
shard8. The first100 page returned after5019.890265ms against BODY5000; setup
was already outside the body. This does not identify a runtime cause. Preserve
that negative run; no deadline, page limit, assertions or authority changes.

Append the unchanged whole56-case checkbox-service file after cold closes:
ordinary -> Room -> cold -> checkbox. Ordinary excludes exactly these three
server files. All selected isolated phases run after earlier native failures,
and first-failure/unknown-selection86/report/quarantine guards remain. The
canonical report and flake record includes all four original native reports,
with raw copies and checksums; checkbox requires56 terminal cases on shard1
and zero on the other seven. Its100+1 stable-keyset/no-effects assertions stay
unchanged. Static1698 membership is1695 ordinary plus three singleton files;
new ownership moves are disclosed separately, not described as old ownership.

A third extra server invocation and the whole checkbox lifecycle add work to
shard1. The failed ordinary file's observed61981ms lifecycle is not a forecast
for isolation; the owner job's actual duration is separately pinned in the
proposal. No headroom or performance guarantee is claimed. Keep the original
thirty-minute budget, worker cap4, PR retry0 and queue retry1. Observe newjob
duration and whole56 behavior as well as the existing0.025/seven-day metric.
This scheduling hypothesis is not a repair verdict; revise or revert if its
new discovery/report guard fails, recovery still fails, or headroom worsens.

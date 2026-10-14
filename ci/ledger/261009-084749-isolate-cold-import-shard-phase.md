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

Actual6fc9 required run37970905492 exceeded the unchanged thirty-minute job
maximum on the owner shard. Ordinary47/47, Room1 and cold33 completed;
checkbox Vitest never entered. The fourth phase was rebuilding prerequisite
tasks (including a2a-gateway) when cancellation occurred. Preserve this
negative and the seven completed other shards/two communities. No checkbox
assertion or product runtime failure is inferred from this cancellation.

Keep the full ordinary Turbo dependency graph. A selected server's fresh
ordinary summary must prove every transitive dependency completed with exit0
(cached success is valid), with no missing executable/cyclic/unknown task,
before reuse. Omitted virtual nodes require exact no-script package manifests
and supported task-config dependencies; recheck that evidence and package
membership alongside recorded directories, build logs and regular outputs.
Snapshot only those tasks' recorded output bodies/modes and declared output
membership; recheck before each isolated phase. Only then insert Turbo2.10.13
--only for that same server test task. Its task definition/environment/filter,
Vitest flags and fresh MISS requirement remain. The task hash loses graph
edges; no cache equivalence or cache replay acceptance is claimed.
An ordinary test failure with completed builds still runs all later phases;
a failed/missing/unknown build or changed output falls back to the original
isolated command with dependencies. First failures remain failures.

This is the same measured failure_rate hypothesis above, target0.025 after7days;
no computed verdict or release is declared. It specifically removes repeated
successful prerequisite execution when readiness is proved, while retaining
fallback and the original30-minute limit. Verify real new CI, output-proof
availability, exact server selection, MISS, complete reports/union, failure
ordering and job duration. No actual ordinary-summary artifact survived the
cancelled run, so that run does not prove the proposed reuse predicate.

Current published commit 4b1c8 required test run reached the real native Room
children but failed their unchanged bootstrap-readiness deadlines. Closed shard 6
recorded module-ready at 11,871, 12,104, 11,284 and 11,919 ms; shard 8 also recorded
about 11.6–12.1 seconds. This marker follows static dependency loading and precedes
fixture setup. Successful children on another shard reached the same marker
around 9.2 seconds. These are observed startup costs, not proof of a missing module
or a measured CPU cause. Preserve the failed checks and their original output.

Test a fifth phase after ordinary, Room, cold and checkbox have closed. Ordinary
excludes the exact six whole files that register original native launch cases:
sessions-cwd-resolution, room-turn-runner, room-original-native-launch,
room-worktree-refresh.integration, room-worktree-refresh and message-dispatcher.
Run that family through the same server task with the original eight-way shard,
reporters, passWithNoTests and event-specific retry flags. Only this family uses
one worker and fileParallelism=false. Keep every original child deadline, load
scaling, setup/body bound, scenario, teardown and native ownership check.

Use the current Vitest configuration and its actual collection/sequencer API to
record selected files before the command. Refuse an unknown or incomplete
six-file collection. Require the selected whole file's original assertion count;
the family contains 275 assertions across its six files. Preserve the original
four raw reports and compose a disjoint fifth report and retry record. Keep the
ordinary task-selection, prerequisite/output reuse, uncached execution and global
file-union checks. Earlier failures still run all selected later phases and stay
failed; an empty shard receives no assertion credit.

The immediate experiment target is zero native bootstrap-readiness failures with
all 275 original assertions executed and no skipped or pending cases, under the
unchanged deadlines. The existing failure-rate/seven-day hypothesis stays in
place. Actual API parity, whole-script regressions, native family execution and
new CI are still pending; this proposal has no observed improvement or verdict.
An extra invocation and collection step add work to each selected server shard.
Keep the thirty-minute job limit and review actual duration and headroom. Revise
or revert if readiness failures remain, discovery or report union changes, any
original assertion is omitted, or the extra phase worsens job completion.
Current published 1399def required test run 38538702837 completed the whole
checkbox-service file with all 57 cases passing. The owner shard then refused
that genuine report because validateCheckbox still required 56 terminal cases;
the job later reached its unchanged thirty-minute cancellation boundary.
Update the exact checkbox report admission to 57, and keep zero cases on the
other seven shards. The whole-file acceptance, status accounting, skipped-case
rejection, original recovery assertions, retry policy and deadlines remain.
The script regression accepts complete 57-case passed or failed reports and
explicitly rejects the obsolete 56-case report. Actual validation of this
counter repair and a fresh required CI run remain pending; this is no waiver
or performance verdict. Historical observations above remain unchanged.

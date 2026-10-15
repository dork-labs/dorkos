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

### Held native whole-file balance experiment

The completed dec374 shard-one job reached its 30-minute job ceiling. Checkbox completed57 assertions before native work began; native work then had about597 seconds remaining. The original96-case Room runner file previously took roughly474–478 seconds locally and constructs95 separate original native children. This does not establish an internal stall or a hosted performance result.

The held candidate moves48 unchanged registrations into one sibling whole file. Both halves keep their original scenario identities, titles, callbacks, private child homes and temporary directories, cold module graphs, assertions and deadlines. The native family becomes seven whole files with the same275 assertions. Actual configured eight-shard selection and disjoint identity union must be checked after adoption; no hash approximation replaces Vitest.

The target is a lower maximum native-file wall time and completion of the full original pipeline inside the unchanged30-minute job limit. All original child readiness/drain and test/hook limits remain. No child pool, partial-file filter, skipped assertion or increased timeout is proposed. Current hosted results, benchmark effect and adoption remain pending.

### Native compiler-cache follow-up (local evidence; hosted outcome pending)

The first post-Main local validation (Source 6) reported 258 passed, 7 failed and
10 pending cases out of the original 275 native assertions. Its inherited worker
environment did not establish the requested one-worker execution. The corrected
Source 7 selected one worker through the actual configured API and reported
264 passed, 2 failed and 9 pending cases. Both runs failed; neither report is
whole-family acceptance. Preserve these reports and their original failures.

Each original child used a fresh private TMPDIR, which also gave the normal tsx
loader a fresh transformation-cache directory. A bounded diagnostic tested a
separate creator-owned compiler-cache root while restoring each child's private
TMPDIR before application imports. Five fresh finite DATA processes passed the
ordering, independent module evaluation, changed-source, changed-compiler-options,
distinct-source-root/relative-import and source-map identity checks. Two separate
original native launch cases then passed, cold first and warm second, with an
empty native compiler cache before the first launch. The full two-case command took
10.678 seconds including runner startup; the file report spans 5.449 seconds. This is diagnostic evidence, not the 275-case benchmark or a
hosted CI result.

The implemented candidate shares only compiler artifacts within one isolated
whole test file. Every native case still forks a fresh process and retains its
private HOME, TMPDIR, DORK_HOME, database, constructor bindings and fixture
lifetime. The normal tsx bootstrap restores the private environment before any
application import. Cache leases close only after the original child exit and
both pipe EOFs, the unchanged drain check, and private fixture cleanup. Failed or
unresolved leases retain the creator-owned cache. Retirement checks prevent a
late asynchronous acquisition from forking after fixture closure.

All original registrations, readiness/load scaling, test-body, hook and drain
clocks remain unchanged. The existing cold-import regression remains unchanged.
The separate Source 7 refresh-story failure crossed its original five-second
body deadline. Its cause was not isolated by the cache diagnostic.

The completed Source 8 local validation used the worktree based on merge commit
5d86340 with the ten pending split/cache files, against Main f35d7bb. All seven
commands exited zero: actual configured eight-shard selection, normal server and
scripts typechecks, the whole 24-case script regression, the whole seven-file
275-case native family, both whole upstream Search files (36 assertions), and
normal max-lines against f35d7bb. Every selected assertion passed with zero
failures, pending or TODO cases. The actual sequencer selected one whole native
file on each of shards 1–7 and none on shard 8; this is local API evidence.

Actual native file-report wall times (including that file's setup and teardown):

| Whole native file                                                                         | Passed assertions | Wall seconds |
| ----------------------------------------------------------------------------------------- | ----------------: | -----------: |
| `apps/server/src/routes/__tests__/sessions-cwd-resolution.test.ts`                        |                30 |       22.775 |
| `apps/server/src/services/rooms/__tests__/room-turn-runner-launch.test.ts`                |                48 |      154.053 |
| `apps/server/src/services/rooms/__tests__/room-turn-runner.test.ts`                       |                48 |      147.910 |
| `apps/server/src/services/session/__tests__/message-dispatcher.test.ts`                   |               101 |       27.502 |
| `apps/server/src/services/rooms/repo/__tests__/room-original-native-launch.test.ts`       |                10 |       35.933 |
| `apps/server/src/services/rooms/repo/__tests__/room-worktree-refresh.integration.test.ts` |                 3 |       11.170 |
| `apps/server/src/services/rooms/repo/__tests__/room-worktree-refresh.test.ts`             |                35 |       37.114 |

The full seven-file native command took 462.122 seconds including runner startup.
The two unchanged 48-case runner halves took 154.053 and 147.910 seconds in their
file reports. The earlier unsplit 96-case runner file took 469.113 seconds in a
separate historical local run. These are different source epochs, and split and
compiler-cache changes were combined; the comparison does not isolate either
change or establish a hosted CI improvement.

The original refresh-story assertion also passed in this run (3.015 seconds of
reported test-body duration) under its unchanged five-second deadline. Its real
Git/HTTP steps and assertions were not moved, removed or replaced. This single
successful run does not isolate why the earlier body deadline was exceeded.

The complete hosted required checks on a new published head remain pending.
Keep the unchanged thirty-minute job limit and existing seven-day hypothesis.
Local correctness and timing evidence do not establish hosted job completion,
required-check acceptance, or a release verdict. The earlier held proposal and
failed-run chronology above remain historical evidence.

### Hosted native admission follow-up, 2026-10-14

The genuine `f1ff48f03cc59d154e0da6b5d2834628d2fbf584` test run `38630174353`, attempt 1, failed in the ordinary parallel server phase on shards 5 and 7. Shard 5 recorded two original merge-fixture admission failures at the unchanged one-second wait. Shard 7 recorded the original canonical recovery test's unchanged five-second failure and a separate config fixture cold-import hook failure. Both failed shards still executed their original isolated phases: the shard 5 native launch file passed all 48 cases and shard 7's original cwd file passed all 30 cases. These are scoped observations, not a green hosted run.

The native phase now also owns the complete 55-case merge-service file and the complete one-case canonical recovery file. These fixtures perform real native Room startup, admission and cleanup, so they belong beside the existing seven native files rather than competing with ordinary server workers. The nine-file family contains 331 original assertions. The actual configured Vitest sequencer still assigns whole files across eight shards; its first shard can select two files, which execute with the existing one-worker, nonparallel-file flags. The phase validator requires the exact selected file set, each file's full original case count, no pending/todo cases, and matching aggregate pass/fail counts.

No test deadline, job ceiling, child lifetime, native identity, assertion or retry policy changes. The original ledger history and cold-import 33-case phase remain intact. Fresh whole-file execution, actual nine-file/eight-shard collection proof, unchanged source guards and hosted CI remain required; the captured negative run does not supply that acceptance. The separate config fixture failure requires its own source-backed correction.

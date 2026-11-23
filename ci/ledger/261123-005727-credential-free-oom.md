---
id: 261123-005727
title: credential-free-build stops running out of memory mid-build
kind: incident-fix
status: proposed
actor: agent
gates: [wf.credential-free-build.credential-free-build]
prs: []
hypothesis:
  metric: 'gate.wf.credential-free-build.credential-free-build.ejections_caused'
  slo: queue-green
  baseline: 6
  baseline_source: 'origin/ci-steward-data snapshots 2026-11-15..2026-11-21 (data branch head d314da8bb6), .ejections_caused["wf.credential-free-build.credential-free-build"] per day 0,0,1,1,3,0,1 = 6; triggers.json agrees ("failed on 6 of 41 queue ejections in 7d; 0 real"). Same window, .gates[...@merge_group]: 7 failures in 502 runs; @pull_request: 23 in 797. Four more kill-signature hits on 2026-11-22 (#4128, #4116, #4145, #4149), after the window.'
  target: 0
  after_days: 7
ratchet-release: []
field-changes: []
---

**The incident (DOR-4813, FG-007).** The build step ("Build, typecheck and lint everything this
change can reach") died 7 to 9 minutes in, with turbo's `Force killed Turborepo tasks`, a bare
`Killed`, and "the runner has received a shutdown signal" (or, once, "lost communication with
the server"). Merge-group run 45075803747 was killed with four tasks in flight:
`@dorkos/server#typecheck`, `dorkos#typecheck`, `@dorkos/desktop#typecheck` and
`@dorkos/desktop#build`.

**Why it is memory.** Each of those, measured alone with this job's
`NODE_OPTIONS=--max-old-space-size=8192` (peak RSS of the largest process, from
`/usr/bin/time -l` on macOS, 2026-11-23; a task with parallel children is understated, and the
memory watch's first runs give the Linux figures): server typecheck
6.3 GB, desktop build 4.7 GB, client build 4.7 GB, server build 4.7 GB, `dorkos` typecheck
3.7 GB, desktop typecheck 3.5 GB. The four in flight at the kill add up to about 18.2 GB on a
16 GB `ubuntu-latest` runner. At `--concurrency=3` the worst three still reach about 15.7 GB,
with nothing left for the runner itself. At 2 the worst pair is about 11 GB.

**The change.** `--concurrency=2` on the build step only. A smaller heap was ruled out: the
server typecheck needs more than 4 GB (it runs out of heap at Node's default ceiling), so a
lower cap would only swap a kill for a heap error. The new memory watch
(`scripts/ci-memory-watch.sh`) samples the runner every 5 s and reports the peak, the kernel's
OOM lines and the biggest processes on every run, red or green, so the next hit proves or
rules out the cause.

**What it may cost.** Wall time on a change whose affected set reaches the server, the client
and desktop (anything under `packages/shared`), where the heavy tasks now run two at a time
instead of four, on both legs: the queue leg is required too, so a slower run holds every batch
behind it. A docs or narrow change is unaffected. Its own guard is ledger 261123-010539 (PR
leg p90 at or under 18.0 min, the queue leg read beside it).

**Confounding.** This entry lists the gate, so it confounds ledger 261117-141554 (which also
lists it, merged 2026-11-17, window still open): that entry's verdict comes out inconclusive,
which is honest, since this change moves the same job. It does not confound 261117-143945,
whose `gates: []` keeps it out of the confounder check; a p90 rise there would be read as
the cache change's, so read it beside 261123-010539.

**Revert, or rather move:** `--concurrency=3` does not fit (about 15.7 GB of 16), so it is not
the way back. If the duration guard fails, split `lint` (light: not type-aware here) into its
own turbo call at a higher concurrency, after `build typecheck` at 2. Raise the build step
above 2 only if the memory watch's peaks at 2 stay under about 8 GB across wide affected
sets. Look elsewhere (the runner, not these flags) if a kill-signature ejection recurs with
the watch showing a peak well under 16 GB.

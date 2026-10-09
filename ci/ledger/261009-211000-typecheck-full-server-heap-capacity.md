---
id: 261009-211000
title: Typecheck gets a heap ceiling the full server scope fits under
kind: incident-fix
status: active
actor: agent
gates:
  - wf.typecheck.typecheck
prs:
  - 2673
hypothesis:
  metric: gate.wf.typecheck.typecheck.failure_rate@pull_request
  baseline: 0.046511627906976744
  baseline_source: 'ci-steward-data@fb415dccaa73e31652d563ae910a0194cf34d841 latest.json dated2026-10-08 collected2026-10-09T11:46:28.623Z points to snapshots/2026-10-08.json; wf.typecheck.typecheck@pull_request conclusions: 2 failure / 43 completed noncancelled (41 success); 3 cancelled excluded. Complete, nontruncated GitHub population. Collector health is false solely for a stale local-export clone, not missing GitHub gate data. This is the fresh saved collector baseline, not the single incident failure rate.'
  target: 0.025
  after_days: 7
ratchet-release: []
field-changes: []
---

Required typecheck job 114022518786 in run 37990325157 against published a47c13c1
failed with server `tsc --noEmit` V8 heap exhaustion at a reported 4051–4108 MB,
exit 134. Turbo completed 47 of 48 tasks with no cache hits; the server task was
the sole compiler-task failure and emitted no TypeScript diagnostics. The same
job first reported six owned retired-vocabulary hits; their copy correction is
separate. This change does not hide or skip either failure.

The local complete source typecheck also exhausted the default heap. An explicit
8 GiB, concurrency-one completion of the four unfinished package scopes passed
all 22 selected tasks and dependencies, with the four input hashes unchanged.
That establishes compiler capacity on the qualified combined source; it does
not establish a green remote run or the remote concurrent memory peak.

Set `NODE_OPTIONS=--max-old-space-size=8192` only on the existing full-monorepo
CI typecheck step. Keep its literal `pnpm exec turbo typecheck --continue`, task
selection, dependency builds, default concurrency, timeout, event legs, required
context, gates and first-failure reporting unchanged. Turbo passes NODE_OPTIONS
to task processes; no production runtime heap setting changes.

GitHub documents public repository Linux `ubuntu-latest` runners as 4 CPUs and
16 GB RAM. This repository is public and the actual job used a GitHub-hosted
Ubuntu 24.04 runner. Source:
https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job

The ceiling is per Node process, not a reservation or a whole-job memory cap.
Fresh CI must demonstrate this concurrent task graph fits runner RAM. Revert or
revise if system-memory OOM replaces V8 heap exhaustion, the compiler still
exhausts 8 GiB, or the measured seven-day failure rate misses 0.025. Investigate
source/type graph growth before raising the ceiling again. No retry, timeout,
quarantine, type exclusion or required-status change is part of this incident.

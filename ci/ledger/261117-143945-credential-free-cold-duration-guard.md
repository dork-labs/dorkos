---
id: 261117-143945
title: credential-free-build's PR leg, now always cold, must not slow past a ceiling
kind: experiment
status: proposed
actor: agent
gates:
  - wf.credential-free-build.credential-free-build
prs: []
hypothesis:
  metric: 'gate.wf.credential-free-build.credential-free-build.duration_p90@pull_request'
  baseline: 16.1
  baseline_source: 'origin/ci-steward-data snapshots 2026-11-10..2026-11-16 (data branch head 787d1d1db1), gates["wf.credential-free-build.credential-free-build@pull_request"].durations: 602 completed runs, p50 9.2, p90 16.1 min. The same window on @merge_group, which never had a warm cache: 371 runs, p50 9.2, p90 15.6 min.'
  target: 18.0
  after_days: 7
ratchet-release: []
field-changes: []
---

The guard for 261117-141554 (caches only main saves): the metric that change could make
worse, with a ceiling.

**What could get worse.** credential-free-build no longer restores a per-PR turbo cache, so a
PR's second and later pushes build their affected set cold, as its first push and every queue
run already did.

**Why it should not by much.** The queue leg has always been cold, and its p90 (15.6 min) is
already within half a minute of the PR leg's (16.1 min): the warm restore was saving little.
**Target is a ceiling**: `verified` means the PR leg's p90 at or under 18.0 minutes, about two
minutes over today, which is what losing the warm restore could plausibly cost.

**Revert** the turbo half of 261117-141554 (put back a restore, and a save only `main` can
make, never the old per-PR save) if the PR leg's p90 sits above 18.0 minutes over the after
window, or its p50 rises by more than 2 minutes.

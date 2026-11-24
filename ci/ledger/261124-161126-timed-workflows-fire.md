---
id: 261124-161126
title: 'Timed workflows fire: daily slots off minute 0 with an after-push backstop, event triggers for review-redispatch and release-window-refresh'
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.daily-release.due
  - wf.daily-release.plan
  - wf.daily-release.slot-done
  - wf.daily-sweep.due
  - wf.daily-sweep.sweep
  - wf.review-redispatch.redispatch
  - wf.release-window-refresh.refresh
prs: []
hypothesis:
  metric: tracked.timed-slot-misses
  baseline: 11
  baseline_source: 'Actions runs API, 2026-11-24 00:03 to 15:55 UTC. daily-release.yml (cron 0 15, merged 14:11) had 0 runs, so its first slot was missed (1). review-redispatch.yml (cron */10, merged 00:03) ran once, at 09:46, against 10 failed claude-code-review runs, none followed by a scan within 15 minutes of its rung (10). Context since 2026-11-21 16:00: review-redispatch 1 scheduled run, release-window-refresh (cron 7-59/15) 2 scheduled runs beside 82 push runs, daily-sweep (cron 0 17, first slot today 17:00) 0.'
  target: 1
  after_days: 7
ratchet-release: []
field-changes: []
---

GitHub's schedules here are not a trigger anything can rely on: the `*/10` and `7-59/15` crons
fired one and two times in three days, and daily-release's `0 15` did not fire on its first day.
Top-of-hour minutes are the busiest; the daily canary crons at odd minutes fire about daily.

- `daily-release.yml` 15:07 UTC and `daily-sweep.yml` 17:13 UTC: off minute 0, plus a backstop on
  `workflow_run` of CLI Smoke Test on main (it runs on every push to main, no path filter). A `due`
  job (`scripts/timed-slot.sh`) goes on only after today's slot, while no cron or backstop run has
  uploaded today's `timed-slot-<workflow>-<date>` artifact, and until 3 runs have failed that day.
  The existing workflow-level concurrency group serializes every run, so the check and the act are
  one step. Dispatch, `DAILY_RELEASE_LIVE` and `DAILY_RELEASE_HOLD` are unchanged.
- `review-redispatch.yml`: also ticks on `workflow_run` of CLI Smoke Test on main (after every
  push), so the scan runs about every 16 minutes on a working day and the existing ladder decides
  SKIP or retry; no runner sleeps. The scan keeps its job-level concurrency group, so ticks collapse.
  The cron stays as the backstop.
- `release-window-refresh.yml`: also wakes on a PR's failed first `release-window` attempt (a
  re-run is attempt 2 and starts nothing, so no loop), and after Release Publish waits up to five
  minutes for npm.

Target: at most 1 miss in 7 days (every daily slot runs within 30 min, every failed review gets a
scan within 15 min of its rung passing (on a day with pushes)). Revert a trigger if its runs cost more than they save, if a slot
ever runs twice in a day, or if the refresh ever re-runs one check in a loop.

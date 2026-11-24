---
id: 261124-132333
title: The daily release workflow runs dry until it is switched on
kind: experiment
status: proposed
actor: agent
gates:
  - wf.daily-release.plan
  - wf.daily-release.cut
  - wf.daily-release.advance
prs: []
hypothesis:
  metric: tracked.merged-to-released
  baseline: 14.2
  baseline_source: 'The last 7 releases, v0.136.0 to v0.141.0 (Nov 18-23): 255 main merges, each from its merge time on main to the npm publish time (npm view dorkos time) of the first release containing it. p50 14.2 h, p90 27.7 h, max 34.8 h.'
  target: 13
  after_days: 30
ratchet-release: []
field-changes: []
---

DOR-5123, build order row 8 of the daily-release design. `daily-release.yml` runs at 15:00 UTC
and by hand as a state machine (`scripts/daily-release.sh`): it reads whether a release is in
flight, decides one step (cut, tag, publish, surfaces, back-merge, wait), picks P (the newest main
commit of the last 48 h whose full browser run on main is green and that `scripts/release-gate.sh`
ships), plans the version with `release-commit.ts` (dry run), and writes what it would do to the
step summary. Every write sits in the `cut` and `advance` jobs, which run only when
`DAILY_RELEASE_LIVE` is `on`, and `plan` refuses to go live while `release-commit.ts --commit` is
not wired. Until #4209 lands, `pick` answers "release-gate.sh is not on main yet".

Baseline over the last 7 releases: lead time p50 14.2 h, p90 27.7 h. Freeze (main's VERSION
merged but not yet on npm, so release-window rule 3 blocks every other merge): 52, 51, 46, 50, 53,
60 and 48 minutes, 360 minutes in all, about 51 per release, plus the click on `npm-release`
every time. Design target, once live: p90 lead time at most 26 h, 0 freeze minutes (VERSION moves
on main only at the back-merge, after npm), 0 clicks. The p50 target of 13 h is a fixed daily cut
with P lagging main by about one rolling run. Evaluate after three releases in a row with no human
step; this dry-run phase moves nothing and runs for three days first.

Revert or stay dry if a dry run ever picks a P that `release-gate.sh` would refuse at publish time,
or names a version the release lead's manual release would not.

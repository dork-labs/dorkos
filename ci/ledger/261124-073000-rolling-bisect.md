---
id: 261124-073000
title: A rolling main run that fails is bisected to the merge that broke it
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.rolling-bisect.next
  - wf.rolling-bisect.report
  - wf.rolling-bisect.revert
prs: []
ratchet-release: []
field-changes: []
---

DOR-5122 / DOR-5130. The full browser suite now runs on main as a rolling push run (one in flight),
so one run covers several merges. `auto-revert.sh` blames a merge only when its parent had its own
green run, which a rolling run almost never has, and `after-merge-alert.sh` (ROLLING=1) lists every
merge in the range but blames nobody.

Now: when browser-test's push run at H still fails after auto-revert's one re-run, `rolling-bisect.yml`
binary-searches the merges since the last green push run G. It dispatches browser-test on main with
`bisect_sha=<midpoint>` (its own concurrency group per merge, so the rolling run is never blocked or
cancelled), titled `bisect <sha> for run <id>`. Budget: at most ceil(log2 N) dispatches for N merges,
N <= 16 (so at most 4 full runs), plus one re-run of the failed jobs of each bisect run that fails,
so a flake never blames anyone. A culprit must fail twice in the same job family as H, with the
merge before it green. It is named on its PR and the failure-group issues by `after-merge-alert.sh
blame`, and reverted through `auto-revert.sh revert` (the same path auto-revert.yml now calls) only
while `AUTO_REVERT` is on, never the release commit. Anything doubtful (a pass after a failure, a
different failing job, a cancelled run, budget exhausted, more than 16 merges, browser-test.yml
changed since G) stops with one note on the failure-group issues and no revert. The suite is not
narrowed to the failed specs: the balanced-shard reporter and the fan-in's every-spec-ran check need
the whole spec set. The canary collector leaves bisect runs out.

Baseline (Nov 24): 0 of the rolling browser-test failures on main name a merge; every one lists the
whole range.
Target: 80% of rolling browser-test failures that survive the re-run end in a named merge within 3
hours of the failure, with no merge named that a person later clears.
Evaluate: Dec 8, against rolling-bisect.yml's logged decisions and the after-merge-failure issues.

Revert if it names a merge a person shows was innocent, or if its dispatches ever delay or cancel a
rolling push run.

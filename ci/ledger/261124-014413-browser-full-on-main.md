---
id: 261124-014413
title: The full browser suite runs on main after merge; the merge queue runs the browser smoke
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-shard
  - wf.browser-test.browser-smoke
  - wf.browser-test.first-run
  - wf.browser-test.browser-test
  - wf.after-merge-alert.alert
prs: []
ratchet-release: []
field-changes: []
---

DOR-5130, approved by Dorian Nov 24 ("move the full browser suite to main as described"). Week of
Nov 16-22: the full browser suite in the queue cost 55,170 runner-minutes, ran 26 min p50 (setting
the queue build's length with the unit tests), and a browser break on main ejected every innocent
PR behind it (room-entry-actions, four builds in a row on Nov 23). About 7 real catches a week.

Now: merge-queue entries run the @smoke shards, scoped to the entry's own change (HEAD^1..HEAD)
with browser-smoke-scope.sh. Main runs the full six shards and first-run on every push, as a rolling
run (the ref-keyed concurrency group keeps one in flight and only the newest waiting). Pull requests
into release branches and the canary keep the full suite. after-merge-alert names every merge in a
failed rolling run's range (ROLLING=1) and comments on a PR only when the range is one merge;
auto-revert acts only when the parent commit's own run was green. The daily release must ship only a
commit whose run is green (DOR-5123).

Baseline: 55,170 queue browser runner-minutes a week; queue browser p50 26.0 min.
Target: queue browser p50 under 12 min; no ejection caused by a browser break already on main.
Evaluate: Dec 1.

Revert if a browser break reaches a release, or more than two real browser breaks a week land on main.

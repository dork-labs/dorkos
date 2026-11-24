---
id: 261124-131757
title: The full unit suite runs on main after every merge (rolling); community legs leave the queue
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.test.test
  - wf.test.test-shard
  - wf.test.community-pg
  - wf.test.community-packaged
  - wf.after-merge-alert.alert
  - wf.auto-revert.decide
prs: []
ratchet-release: []
field-changes: []
---

DOR-5130 step 5, approved by Dorian Nov 24: "the merge queue runs what its batch changed plus
everything that depends on it; the full suite runs on main (rolling) + daily canary + pre-release".
This is the main half; the queue half (affected-only unit tests in the queue) follows in its own PR.

Now: test.yml runs on `push` to main, taking the full side of every split exactly as the canary does
(ten shards, binary suites, retry budget, quarantine lane, union proof). The ref-keyed concurrency
group keeps one run in flight and only the newest main waiting, as browser-test.yml has since #4231.
community-pg and the packaged community proof leave the queue (about 25 runner-minutes per queue
build: 12-15 and 10-12 min in the last five green builds) and run on that push run, the canary and
release pull requests; the `test` fan-in accepts community-pg's skip on `merge_group` as on a pull
request, and community-packaged's scope step answers `run=false` there. after-merge-alert (ROLLING=1)
and auto-revert read the push runs. Shard 1 of a push run does not save the build cache:
build-cache.yml already saves the same key after every merge.

Baseline (week of Nov 16-22): queue test-shard 57,233 runner-min/week, queue `test` p50 21.2 min;
468 queue builds of test.yml that week, so the community legs cost about 11,700 queue runner-min/week.
Target: community-\* queue runner-minutes 0; every merge to main covered by a full `test` push run
that finishes within 60 min of the merge; the release gate (DOR-5123) can require a green full `test`
run on the release commit.
Evaluate: Dec 1.

Revert if a community break reaches a release, or the rolling run is red more than twice a week on
breaks the queue would have caught.

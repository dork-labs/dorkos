---
id: 261117-174608
title: 'merge-tail: ask GitHub again when mergeability is still being computed'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.merge-tail.arm
prs: []
hypothesis:
  metric: 'tracked.merge-tail-unknown-skips'
  baseline: 10
  baseline_source: 'merge-tail run 44136162869 (2026-11): 10 PRs logged as SKIP mergeability-unknown, 0 armed'
  target: 1
  after_days: 7
ratchet-release: []
field-changes: []
---

GitHub computes a PR's `mergeStateStatus` lazily. Every merge to main resets it to UNKNOWN
on every open PR, and only a query starts it computing again. merge-tail ticks about 2.7 h
apart, so it almost always reads the reset value, and the gate (rightly) skips UNKNOWN. The
gate's comment said "the next scheduled run sees a resolved value, so waiting costs nothing";
that was false, and run 44136162869 held 10 PRs this way and armed none.

`should-arm-automerge-input.sh` now asks again for a PR whose status is UNKNOWN, once every
other answer has been accepted: `gh pr view --json headRefOid,mergeStateStatus`, 3 s apart, up
to 3 times. Only a status for the same head commit replaces UNKNOWN; a failed or odd answer
uses up a try, and an answer about a new head ends the asking. Still UNKNOWN stays UNKNOWN and
the gate skips it as before (fail-closed). The workflow stops asking for the rest of a tick
once 3 PRs in a row stay UNKNOWN, so the 10-minute job timeout holds with 100 open PRs.

Revert if a PR is armed with a status the gate would have refused, or if ticks start hitting
`timeout-minutes`.

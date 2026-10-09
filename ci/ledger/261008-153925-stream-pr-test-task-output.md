---
id: 261008-153925
title: Stream affected test task output before a cancelled job loses its frontier
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: [2673]
ratchet-release: []
field-changes: []
---

The current PR shard1 stopped at the existing thirty-minute job deadline.
Turbo grouped logs showed completed client and Site suites, then no output
for seventeen minutes and forty-four seconds. The running package and
unfinished test could not be identified from that buffer.

The PR-only affected command now emits task output as it arrives under its unchanged full-logs default. Test selection, task dependency graph, serial package concurrency,
cache behavior, workers, assertions, retry budget, deadlines, and fan-in are
unchanged. This improves diagnostic visibility; it neither repairs nor
waives the cancelled run and claims no elapsed-time improvement.

Validate the exact command delta and CI Steward census/ledger/coverage.
The next genuinely changed-head run must expose task-labelled output while
a task is running. A pass is current-check evidence, not proof of the prior
cancellation's cause. Retain the original failed/cancelled attempt.

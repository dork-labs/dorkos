---
id: 261103-094518
title: security-gate logs each read of security-review while it waits
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
prs: []
ratchet-release: []
field-changes: []
---

## Why

DOR-3710's wait has only run in tests. Its first live run found the verdict already written, and nothing in a job log shows whether a run polled. The PM's bar for requiring the gate on marketplace needs a log that shows the wait polled and then passed.

## What changes

One log line per read: the poll number, the status and its time, and the time the verdict must be newer than. No decision changes.

## Hypothesis

Nothing measurable moves. Revert if the line breaks a run or adds noise nobody reads.

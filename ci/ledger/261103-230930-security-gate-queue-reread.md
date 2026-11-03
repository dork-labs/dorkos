---
id: 261103-230930
title: security-gate re-reads the merge queue for up to 60s before refusing a group whose commit it can't find yet (hardening)
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

GitHub can list a new merge-queue entry before it fills in the entry's `headCommit`. Observed on 2026-11-03: #3477's entry was `QUEUED` with `headCommit` null for about 17s (23:12:56 to 23:13:13), polled every 2s. A `security-gate` run that reads the queue inside that window can't walk to its own group commit and refuses with `Cannot resolve queued commit <sha>`, before any test runs. This closes that window (DOR-3564).

This is hardening, not the fix for #3477's ejections that evening. Those were `queue-repeat-guard` taking #3477 out of the queue before the gate read it ("browser-test failed twice on 13c9d6889d", run 41737395887). The gate then found no entry. That was cleared with `requeue-ok`. DOR-3804 makes the gate name a dequeue like that.

## What changes

- **Only that one miss is re-read.** If the first walk can't find a queued commit, the gate reads the queue again every 5s for up to 60s and logs each read.
- **Everything else refuses as before:** a cycle, an incomplete entry, an empty group, and the "queue changed during review" check at the end. The end check stays a single read.
- **Still fails closed.** When the 60s run out it refuses with the same message. 60s keeps the run well inside the job's limit.

Revert if a group that was really dequeued or rebuilt passes, or if a merge-group run approaches the job limit while re-reading.

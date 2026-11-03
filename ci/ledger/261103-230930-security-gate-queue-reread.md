---
id: 261103-230930
title: security-gate re-reads the merge queue for up to 60s before refusing a group it can't find yet
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
prs: []
ratchet-release: []
field-changes: []
---

## Why

A merge group stacked on another entry's group starts its `security-gate` run before GitHub fills in its own entry's `headCommit`. Read 20-30s after the group was created, the queue walk found nothing and the gate refused with `Cannot resolve queued commit <sha>`, before any test ran. It ejected #3477 twice on 2026-11-03 (run 41735691656 at 23:01Z, then 23:03Z). Both groups sat on #3463's group (DOR-3564).

## What changes

- **Only that one miss is re-read.** If the first walk can't find a queued commit, the gate reads the queue again every 5s for up to 60s and logs each read.
- **Everything else refuses as before:** a cycle, an incomplete entry, an empty group, and the "queue changed during review" check at the end. The end check stays a single read.
- **Still fails closed.** When the 60s run out it refuses with the same message. 60s keeps the run well inside the job's limit.

## Hypothesis

Merge-group refusals with `Cannot resolve queued commit` go from 2 per day (2026-11-03) to 0 over the 14 days after merge, read from the security-gate run list. Before 2026-11-03 there were none in the 60 failed runs since 2026-10-27.

Revert if a group that was really dequeued or rebuilt passes, or if a merge-group run approaches the job limit while re-reading.

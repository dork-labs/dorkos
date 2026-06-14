---
number: 276
title: Auto-Merge on Approval, Guarded by a Recovery Ladder
status: proposed
created: 2026-06-14
spec: unified-workflow-system
superseded-by: null
---

# 276. Auto-Merge on Approval, Guarded by a Recovery Ladder

## Status

Proposed

## Context

Human approval authorizes one specific state — this diff, green, cleanly mergeable — but that exact state can go stale (base moved, CI flaked, a fix touched logic) before the merge actually runs.

## Decision

On approval plus CI green, auto-merge, close, and tear down the worktree. At merge time, check three preconditions — mergeable, CI-green, functionally-unchanged — and route each failure through the calibration ladder: mechanical/no-functional-risk (clean rebase, import/lockfile conflict, CI flake) → resolve + announce; a real tradeoff or behavior-altering change → bounce or re-request approval. Runaway bouncing trips the circuit breaker.

## Consequences

### Positive

- A hands-off merge tail without ever shipping unreviewed behavior.
- Honest: behavior drift since approval forces explicit re-approval.

### Negative

- More merge-time logic to implement and test.
- The mechanical-vs-functional boundary requires careful, conservative judgment.

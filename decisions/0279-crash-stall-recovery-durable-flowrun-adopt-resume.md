---
number: 279
title: Crash/Stall Recovery via a Durable FlowRun and Adopt-and-Resume
status: proposed
created: 2026-06-14
spec: unified-workflow-system
superseded-by: null
---

# 279. Crash/Stall Recovery via a Durable FlowRun and Adopt-and-Resume

## Status

Proposed

## Context

Agent sessions are ephemeral; a claimed issue whose session dies mid-flight (crash, circuit breaker, token budget) must not restart from scratch or be left stranded In-Progress — and work legitimately parked on a human must never be reclaimed.

## Decision

Keep a durable `FlowRun` record (issueId ↔ sessionId ↔ worktree) as the session↔issue association, on disk in v1 and graduating to server SQLite in v2. The checkpoint is the git commit plus the JSONL session, so recovery resumes (re-attach the worktree at HEAD, replay the session) rather than restarts. `agent/needs-input` is a distinct "parked on a human" state the stall sweep never reclaims. v1 sequential needs no lease; v2 concurrency adds a heartbeat and a fencing token.

## Consequences

### Positive

- Durable, resumable, and never steals parked work; strictly better than in-memory claims.
- The JSONL session already is an event log, so resume is cheap.

### Negative

- A run record to keep consistent with the tracker and the workspace.
- v2 concurrency introduces heartbeat/fencing/locking complexity.

---
id: 260926-141753
title: DorkOS keeps usage per Claude account in a shared ledger it merges by observation time
status: draft
created: 2026-09-26
spec: claude-account-fleet
superseded-by: null
---

# 260926-141753. DorkOS keeps usage per Claude account in a shared ledger it merges by observation time

## Status

Draft (auto-extracted from spec: claude-account-fleet)

## Context

DorkOS saw usage on every turn but kept it per session and lost it on restart. flow reads usage from files so it works without DorkOS, and the operator needs one number per account.

## Decision

- DorkOS keeps one usage record per Claude config directory, fed by `rate_limit_event` and the SDK usage call.
- For a registered account it persists the record as `<dork-home>/usage/<id>.json`, the same file flow writes, in the shared contract's shape.
- Every writer follows the shared contract (marketplace `flow-cli-core` §1.2): merge per window keeping the strictly later `observedAt`, take an exclusive-create lock with a random token, write a temp file and rename it over the ledger.
- An unregistered root is kept in memory only, because it has no id to name a file.

## Consequences

- Positive: one source of truth across flow and DorkOS; survives restarts; no new database table.
- Negative: a writer that cannot get the lock within 2 s drops that write (memory keeps it; the next flush retries); unregistered roots are invisible to flow.

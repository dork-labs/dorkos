---
number: 36
title: Compute Agent Health Status at Query Time via SQL
status: draft
created: 2026-02-25
spec: mesh-observability-lifecycle
superseded-by: null
---

# 36. Compute Agent Health Status at Query Time via SQL

## Status

Draft (auto-extracted from spec: mesh-observability-lifecycle)

## Context

Agent health tracking needs a 3-state model (active/inactive/stale) based on last Relay message activity. Two approaches considered: (1) store health status in a column and update via background jobs, or (2) compute status at query time from a `last_seen_at` timestamp using SQL CASE WHEN expressions.

## Decision

Compute health status at query time via SQL `CASE WHEN` on the `last_seen_at` column. Thresholds: active < 5 min, inactive 5-30 min, stale > 30 min (or never seen). The `last_seen_at` and `last_seen_event` columns are added to the existing `agents` table via a v2 migration. No separate health table, no stored status column, no background timer jobs.

## Consequences

### Positive

- Zero background jobs or timers needed for status transitions
- Status always reflects current reality (no stale cached status)
- Single SQL query returns agents with correct health status
- Simple migration — just two ALTER TABLE ADD COLUMN statements
- Extends existing agents table rather than adding complexity

### Negative

- Slightly more complex SQL queries (CASE WHEN in every health query)
- Thresholds are hardcoded initially (configurable later if needed)
- Cannot query historical health transitions (only current state)

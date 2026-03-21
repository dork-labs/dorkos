---
number: 164
title: Reuse Entity Query Caches Without Dedicated Dashboard Polling
status: draft
created: 2026-03-20
spec: dashboard-content
superseded-by: null
---

# 164. Reuse Entity Query Caches Without Dedicated Dashboard Polling

## Status

Draft (auto-extracted from spec: dashboard-content)

## Context

The dashboard displays data from sessions, Pulse schedules/runs, Relay adapters/dead-letters, and Mesh status. Each subsystem entity hook already has its own polling interval (Sessions configurable, Pulse 10s when running, Relay adapters 10s, dead letters 30s, Mesh 30s). The question was whether dashboard feature hooks should introduce their own polling configuration to ensure fresh data, or rely entirely on the existing entity hook caches.

## Decision

Dashboard feature hooks depend entirely on entity hook cache states. They are derived hooks — they filter, aggregate, and transform cached data but introduce no independent `refetchInterval` configurations. If a user navigates from `/session` to `/`, the TanStack Query cache is already warm. After long idle periods, data may be stale until the next entity-level refetch cycle.

## Consequences

### Positive

- Single source of polling configuration — changes to entity intervals automatically ripple to dashboard
- Dashboard load adds zero network overhead beyond existing polls
- Cache consistency guaranteed: dashboard and session views always agree on data
- Simpler testing — mock entity hooks only, no mock polling intervals to configure

### Negative

- Dashboard freshness depends on entity hook polling, not dashboard-specific needs
- After long idle periods, data may be briefly stale until entity caches refresh
- Cannot tune poll intervals specifically for dashboard use cases without affecting all consumers

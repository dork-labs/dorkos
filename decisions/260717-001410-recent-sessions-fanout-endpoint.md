---
id: 260717-001410
title: Cross-agent recent sessions via a server-side fan-out endpoint with a per-agent activity map
status: proposed
created: 2026-07-17
spec: agent-sidebar-organization
superseded-by: null
---

# 260717-001410. Cross-agent recent sessions via a server-side fan-out endpoint with a per-agent activity map

## Status

Proposed

## Context

Session storage is runtime-owned (ADR-0310): there is no unified transcript store, and `GET /api/sessions` lists one project directory's sessions. No primitive existed for "the latest sessions across all agents" — the sidebar's Recent section needs exactly that, and per-group "Recent activity" sorting needs a per-agent last-activity signal. Client-side fan-out (N queries per client) would duplicate aggregation logic and multiply request load.

## Decision

We will add `GET /api/sessions/recent` backed by `services/session/recent-sessions.ts`: enumerate agent project paths via `meshCore.listWithPaths()`, fan out the existing `aggregateSessionList` per path with bounded concurrency (5), filter sessions to exact `cwd` = `projectPath` (the DOR-203 canonical membership rule, applied server-side), merge and sort by `updatedAt`, and return `{ sessions, agentActivity, warnings }`. `agentActivity` (projectPath → latest session timestamp) is computed before the trim so it is complete for every agent, powering client-side recency sorting at no extra cost. Degradation follows ADR-0310's `warnings[]` envelope; per-runtime 2s timeouts are inherited.

## Consequences

### Positive

- One reusable cross-agent session primitive (future global search/export can build on it) with a single server-side implementation
- The `agentActivity` by-product eliminates a second endpoint or N per-agent queries for group sorting
- Inherits the proven degradation contract — one slow runtime cannot blank the sidebar

### Negative

- O(agents × runtimes) reads per request; acceptable at tens of agents with 30s client staleTime, but fleets of hundreds will need a server-side cache
- Recency data in the sidebar is eventually consistent (staleTime + SSE invalidation), not live-ordered

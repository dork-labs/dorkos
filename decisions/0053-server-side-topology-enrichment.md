---
number: 53
title: Server-Side Cross-Subsystem Topology Enrichment
status: draft
created: 2026-02-26
spec: mesh-topology-elevation
superseded-by: null
---

# 53. Server-Side Cross-Subsystem Topology Enrichment

## Status

Draft (auto-extracted from spec: mesh-topology-elevation)

## Context

The topology chart needs to display cross-subsystem data per agent: Relay adapter names, Relay subject, Pulse schedule count, health status, and last-seen timestamp. This data lives in three separate subsystems (Mesh registry, Relay adapter manager, Pulse store). The client could make N+1 requests to gather this data per agent, or the server could join the data into the topology response.

## Decision

Extend the `GET /api/mesh/topology` response to include enriched per-agent fields: `relayAdapters: string[]`, `relaySubject: string | null`, `pulseScheduleCount: number`, `lastSeenAt: string | null`, `lastSeenEvent: string | null`, and `healthStatus`. The server performs the joins from RelayCore (adapter list), PulseStore (schedules by CWD), and AgentHealth (SQL query-time computed status per ADR-0036). All new fields have sensible defaults (empty arrays, null, 0) for backward compatibility.

## Consequences

### Positive

- Single request provides complete per-agent context for the topology chart
- Eliminates N+1 client-side queries (one per agent for each subsystem)
- Server has direct access to all stores — no cross-origin or auth concerns
- Default values ensure backward compatibility with existing clients

### Negative

- Topology endpoint becomes a cross-subsystem aggregation point — changes to Relay, Pulse, or Health schemas may require coordinated updates
- Response payload grows; for 20+ agents with multiple adapters, the response size increases meaningfully
- Server-side joins add latency to the topology endpoint (mitigated by the stores being local SQLite)

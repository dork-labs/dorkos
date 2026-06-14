---
number: 109
title: Store Adapter Events in Trace Table via JSON Metadata
status: draft
created: 2026-03-11
spec: relay-mesh-quality-improvements
superseded-by: null
---

# 109. Store Adapter Events in Trace Table via JSON Metadata

## Status

Draft (auto-extracted from spec: relay-mesh-quality-improvements)

## Context

Individual adapters lack event visibility — connections, disconnections, message flow, errors, and status changes are only visible in server logs. Adding an adapter event log requires deciding where to store adapter lifecycle events. The existing `relay_traces` table (Drizzle schema in `packages/db/src/schema/relay.ts`) stores message delivery telemetry with a `metadata` JSON column. A dedicated `adapter_events` table would provide cleaner queries but requires a new migration, new Drizzle schema, and new query infrastructure.

## Decision

Store adapter events as trace spans in the existing `relay_traces` table, using the `metadata` JSON column to carry `adapterId` and `eventType` fields. Query adapter events via `json_extract(metadata, '$.adapterId')`. The `traceId` field is set to the adapter ID to group events by adapter.

## Consequences

### Positive

- Zero new database infrastructure — no migration, no new table, no new Drizzle schema
- Reuses existing TraceStore class and relay routes pattern
- Adapter events benefit from existing TTL-based cleanup when implemented
- Single table for all relay telemetry simplifies operational monitoring

### Negative

- `json_extract()` queries are slower than indexed column lookups — may degrade as traces table grows
- Semantic overloading of the traces table (delivery traces vs adapter events have different schemas)
- If performance becomes an issue, a follow-up migration to add a dedicated `adapterId` column with an index will be needed

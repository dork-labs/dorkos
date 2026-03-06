---
number: 79
title: Derive Endpoint Type from Subject Prefix at List Time
status: draft
created: 2026-03-05
spec: relay-inbox-lifecycle
superseded-by: null
---

# 0079. Derive Endpoint Type from Subject Prefix at List Time

## Status

Draft (auto-extracted from spec: relay-inbox-lifecycle)

## Context

`relay_list_endpoints` returned raw `EndpointInfo` objects with no indication of endpoint role (`dispatch`, `query`, `persistent`, `agent`). Agents consuming the list had to pattern-match subject strings manually to understand topology. Storing a `type` field in `EndpointInfo` would require a schema migration in `EndpointRegistry`. An alternative is to derive the type from the subject prefix at list time, since the existing codebase already uses subject prefix as the canonical discriminator (e.g., `ClaudeCodeAdapter` branches on `relay.inbox.dispatch.*` vs `relay.inbox.query.*` using `startsWith`).

## Decision

We derive endpoint type from subject prefix at list time using a pure `inferEndpointType(subject)` utility function in `packages/relay/src/types.ts`. The type is never stored in `EndpointInfo` or on disk. The `relay_list_endpoints` handler calls this function for each endpoint and includes `type` and `expiresAt` in the response. `RelayCore.getDispatchInboxTtlMs()` provides the TTL value for computing `expiresAt`.

## Consequences

### Positive

- Zero schema migration — no changes to `EndpointInfo` interface, `EndpointRegistry`, or any storage layer.
- Single source of truth: subject naming convention is both the runtime discriminator and the display classification.
- `inferEndpointType` can be reused by the TTL sweeper and any future consumers without import cycles.

### Negative

- `type` is not available on `EndpointInfo` itself; callers who need it must call `inferEndpointType(ep.subject)` explicitly.
- Classification accuracy depends on strict adherence to the `relay.inbox.dispatch.*` / `relay.inbox.query.*` subject convention; custom subjects outside this hierarchy receive `'unknown'`.

---
number: 253
title: Separate DELETE Endpoint for Agent Data Removal
status: proposed
created: 2026-04-14
spec: agent-hub-management-actions
superseded-by: null
---

# 0253. Separate DELETE Endpoint for Agent Data Removal

## Status

Proposed

## Context

When adding the ability to delete an agent's `.dork` directory alongside unregistering it, we needed to decide whether to extend the existing `DELETE /mesh/agents/:id` endpoint (e.g., with a `?deleteData=true` query param) or create a distinct endpoint. The existing endpoint handles unregister-only and is well-established.

## Decision

Create a separate `DELETE /mesh/agents/:id/data` endpoint that performs both unregistration and `.dork` directory deletion. The existing `DELETE /mesh/agents/:id` continues unchanged for unregister-only.

## Consequences

### Positive

- Explicit intent in logs and audit trails — the resource path distinguishes unregister from full deletion
- No risk of accidental data deletion via the existing endpoint
- Cleaner API evolution — each endpoint has a single responsibility
- Easier to add middleware or rate limiting to the destructive endpoint independently

### Negative

- Two endpoints that both trigger unregistration (slight duplication in the route handler)
- Slightly larger API surface area

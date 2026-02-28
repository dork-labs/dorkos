---
number: 47
title: Use Most-Specific-First Binding Resolution Order
status: draft
created: 2026-02-28
spec: adapter-agent-routing
superseded-by: null
---

# 47. Use Most-Specific-First Binding Resolution Order

## Status

Draft (auto-extracted from spec: adapter-agent-routing)

## Context

When multiple bindings exist for the same adapter, the system needs a deterministic way to resolve which binding handles an inbound message. Options included first-match (order-dependent), strict-match (no wildcards), and scored most-specific-first matching (OpenClaw pattern). Messages carry adapterId, optional chatId, and optional channelType metadata.

## Decision

Use a scored most-specific-first resolution order (OpenClaw pattern). Bindings are scored based on how many fields they match: adapterId+chatId+channelType (score 7) > adapterId+chatId (score 5) > adapterId+channelType (score 3) > adapterId only/wildcard (score 1). Explicit field mismatches score 0 and are excluded. The highest-scoring binding wins. Overlapping bindings are allowed with a UI warning.

## Consequences

### Positive

- Deterministic and predictable — same input always selects the same binding
- Supports both specific routes (one chat to one agent) and wildcards (all chats to default agent)
- Flexible — users can layer specific overrides on top of catch-all bindings

### Negative

- Users may not immediately understand why one binding wins over another
- Overlapping bindings can create subtle priority issues
- Scoring logic must be consistent across BindingStore and any UI that previews resolution

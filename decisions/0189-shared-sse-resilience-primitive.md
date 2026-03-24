---
number: 189
title: Shared SSE Resilience Primitive (Class + Hook)
status: draft
created: 2026-03-24
spec: sse-resilience-connection-health
superseded-by: null
---

# 189. Shared SSE Resilience Primitive (Class + Hook)

## Status

Draft (auto-extracted from spec: sse-resilience-connection-health)

## Context

DorkOS uses SSE for three critical real-time features: POST chat streaming, GET session sync, and GET relay event stream. Each has different resilience characteristics — relay has basic connection tracking, session sync has none, and POST streaming has no retry. This creates duplicate patterns, inconsistent behavior, and gaps where connections can silently fail. Research into production SSE patterns (Slack, Linear, Figma) shows that a shared resilience primitive with exponential backoff, heartbeat watchdog, and page visibility optimization is the industry standard.

## Decision

We will create an `SSEConnection` class in `shared/lib/transport/` that encapsulates the state machine (connecting → connected → reconnecting → disconnected), exponential backoff with full jitter, heartbeat watchdog, and page visibility optimization. A thin `useSSEConnection` hook in `shared/model/` wraps the class for React lifecycle management. Both relay and session sync SSE consumers refactor to use this shared primitive.

We chose the class + hook combo over a hook-only approach because the class is independently testable without React, and over a singleton manager because session-scoped connections don't need to survive route changes.

## Consequences

### Positive

- SSE resilience logic is testable in isolation (no React, no DOM)
- All SSE consumers gain consistent reconnection, backoff, and health monitoring
- New SSE consumers get resilience for free by using `useSSEConnection`
- Reduced code duplication (relay hook drops from 67 to ~20 lines)

### Negative

- Two files instead of one (class + hook) adds slight structural complexity
- Existing relay and session sync code must be refactored (migration cost)
- The SSEConnection class introduces a new abstraction that developers must learn

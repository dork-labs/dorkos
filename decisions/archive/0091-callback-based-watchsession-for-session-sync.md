---
number: 91
title: Callback-Based watchSession for Session Sync
status: proposed
created: 2026-03-06
spec: agent-runtime-review-remediation
superseded-by: null
---

# 0091. Callback-Based watchSession for Session Sync

## Status

Proposed

## Context

The `AgentRuntime` interface declares `watchSession()` for session change notification, but the Claude Code implementation was a dead stub returning `() => {}`. Routes instead accessed `getSessionBroadcaster()` directly — a non-interface escape hatch that leaked Claude Code internals and placed `sessionBroadcaster` on `app.locals`. This meant a second runtime would have no way to provide session sync through the abstraction, and routes were hardcoded to Claude Code's broadcasting implementation.

Two approaches were considered: (1) expose a `registerSseClient()` method on the runtime that accepts an Express `Response` directly, or (2) use callback-based `watchSession()` where routes write SSE events in the callback.

## Decision

Make `watchSession()` functional via a callback pattern. Add `registerCallback()` to `SessionBroadcaster` alongside the existing `registerClient()`. The runtime's `watchSession()` delegates to `registerCallback()` and returns an unsubscribe function. Routes call `watchSession(sessionId, projectDir, callback)` where the callback writes SSE events to the response. This eliminates `app.locals.sessionBroadcaster` and keeps the runtime interface transport-agnostic.

## Consequences

### Positive

- Runtime interface is honest — `watchSession()` works, no dead stubs
- Transport-agnostic — the callback pattern works for SSE, WebSocket, or any future transport
- Removes `app.locals` escape hatch — all session sync goes through the runtime abstraction
- Future runtimes can implement their own session sync without conforming to SSE specifics

### Negative

- Slightly more indirect than direct `registerClient()` for SSE — the callback adds one layer of indirection
- Route code is marginally more verbose (sets up SSE init + callback + cleanup explicitly)

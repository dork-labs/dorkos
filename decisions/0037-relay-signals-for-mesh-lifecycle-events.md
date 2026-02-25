---
number: 37
title: Use Relay Signals for Mesh Agent Lifecycle Events
status: draft
created: 2026-02-25
spec: mesh-observability-lifecycle
superseded-by: null
---

# 37. Use Relay Signals for Mesh Agent Lifecycle Events

## Status

Draft (auto-extracted from spec: mesh-observability-lifecycle)

## Context

Agent lifecycle events (registered, unregistered, health status changed) need to be broadcast to interested observers. Two approaches: (1) emit via Relay's SignalEmitter on `mesh.agent.lifecycle.*` subjects, allowing any subsystem to subscribe, or (2) emit directly to SSE streams, bypassing Relay.

## Decision

Emit lifecycle events as Relay ephemeral signals on `mesh.agent.lifecycle.{event}` via SignalEmitter. Server-side SSE streams subscribe to these signals and fan out to connected clients. This leverages the existing NATS-style pattern matching infrastructure and allows other subsystems (Pulse, future supervisors) to subscribe to mesh events.

## Consequences

### Positive

- Consistent with existing Relay signal patterns (SignalEmitter)
- Other subsystems can subscribe to mesh lifecycle events
- NATS-style wildcards enable flexible filtering (e.g., `mesh.agent.lifecycle.>`)
- Decoupled — mesh emits signals without knowing who listens

### Negative

- Requires Relay to be enabled for lifecycle events (graceful degradation when disabled)
- Additional wiring to pass SignalEmitter through MeshOptions to RelayBridge
- Signals are ephemeral (in-memory only) — no persistence of lifecycle history

---
number: 20
title: Use Adapter Registry Pattern with Promise.allSettled for Error Isolation
status: proposed
created: 2026-02-24
spec: relay-external-adapters
superseded-by: null
---

# 20. Use Adapter Registry Pattern with Promise.allSettled for Error Isolation

## Status

Proposed (auto-extracted from spec: relay-external-adapters)

## Context

The Relay adapter system needs to manage multiple external adapters (Telegram, webhooks, future Slack/email) with independent lifecycles. A crashing adapter must not affect others. Hot-reload of adapter config must not cause message gaps. The system needs a central point for adapter discovery, lifecycle management, and delivery routing.

## Decision

Use a `Map<id, RelayAdapter>` registry pattern with `Promise.allSettled()` for all multi-adapter operations (shutdown, broadcast delivery). Hot-reload follows the sequence: start new adapter, register it, then stop the old one. If the new adapter fails to start, the old instance stays active.

## Consequences

### Positive

- One adapter crashing never stops others — Promise.allSettled guarantees all adapters get a chance to execute
- Hot-reload with no message gap — new adapter starts receiving before old one stops
- Rollback safety — if new adapter fails to start, old instance remains active uninterrupted
- Simple Map-based lookup by ID or subject prefix prefix — O(n) scan is fine for <10 adapters

### Negative

- Promise.allSettled swallows individual errors — must explicitly log each rejection
- Hot-reload creates a brief window where both old and new adapter may process the same message (acceptable for at-most-once delivery)
- No persistent adapter state — adapter restarts lose in-flight message context

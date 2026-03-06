---
number: 80
title: Use Periodic Sweeper for Dispatch Inbox TTL Management
status: draft
created: 2026-03-05
spec: relay-inbox-lifecycle
superseded-by: null
---

# 0080. Use Periodic Sweeper for Dispatch Inbox TTL Management

## Status

Draft (auto-extracted from spec: relay-inbox-lifecycle)

## Context

Dispatch inboxes (`relay.inbox.dispatch.*`) are caller-managed — the calling agent is expected to call `relay_unregister_endpoint` when `done: true` is received. If the caller crashes or omits cleanup, the inbox persists indefinitely on disk (Maildir directory + chokidar file watcher). Three TTL management patterns were evaluated: (1) periodic sweeper — one `setInterval` for all endpoints, runs every N minutes; (2) timer-per-resource — one `setTimeout` per dispatch inbox at registration time, precise expiry; (3) lazy cleanup on `listEndpoints` — check age only when listing, no background timer.

## Decision

We use a periodic sweeper (`setInterval`, 5-minute default interval) started in the `RelayCore` constructor (alongside `startConfigWatcher()`) and stopped in `close()`. The sweeper iterates all registered endpoints, calls `inferEndpointType()`, and unregisters any dispatch endpoint older than `dispatchInboxTtlMs` (default: 30 minutes). The timer uses `.unref()` to avoid preventing process exit. `EndpointRegistry.unregisterEndpoint()` returns `false` gracefully for already-removed endpoints, making the sweeper race-safe against explicit caller cleanup.

## Consequences

### Positive

- Single timer handle regardless of the number of dispatch inboxes — no handle accumulation under high inbox creation rates.
- Simple to cancel: `clearInterval` in `close()` is sufficient.
- `.unref()` ensures the sweeper does not block process exit in test environments or graceful shutdown scenarios.
- Configurable via `RelayOptions.dispatchInboxTtlMs` and `RelayOptions.ttlSweepIntervalMs` constructor params.

### Negative

- Imprecision of ±5 minutes on a 30-minute TTL (17% max drift) — acceptable for a resource-cleanup safety net, not for strict SLA expiry.
- All endpoints are iterated every sweep, even if none are expired — acceptable at the expected scale (hundreds of endpoints maximum).
- Timer-per-resource would provide precise expiry but was rejected due to handle accumulation risk.

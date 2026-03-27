---
number: 57
title: Use BroadcastChannel + SSE for Cross-Tab Tunnel Sync
status: proposed
created: 2026-03-01
spec: tunnel-remote-access-overhaul
superseded-by: null
---

# 57. Use BroadcastChannel + SSE for Cross-Tab Tunnel Sync

## Status

Proposed

## Context

DorkOS can be opened in multiple browser tabs simultaneously, and users may also access it from remote devices via the ngrok tunnel. When the tunnel status changes (connected, disconnected, URL change), all clients need to reflect the updated state. Polling-based approaches add unnecessary network overhead and latency. The codebase has no existing cross-tab communication pattern.

## Decision

Use the BroadcastChannel API for same-browser tab synchronization and a dedicated SSE endpoint (`GET /api/tunnel/stream`) for cross-device synchronization. When any tab changes tunnel state, it broadcasts via BroadcastChannel. Remote devices subscribe to the SSE stream. Both channels trigger TanStack Query invalidation of `['tunnel-status']` and `['config']` query keys.

## Consequences

### Positive

- Zero-latency same-browser sync (BroadcastChannel is in-memory)
- Cross-device sync works through the tunnel itself via SSE
- No polling overhead; event-driven architecture
- BroadcastChannel wrapper is generic and reusable for future cross-tab needs
- Clean separation: BroadcastChannel for local, SSE for remote

### Negative

- BroadcastChannel not available in Web Workers (not an issue for current use case)
- SSE requires an active connection per client
- Two communication channels to maintain instead of one

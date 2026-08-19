---
id: 260819-210154
title: The sidebar boots from a persisted query cache, gated by one boot state and one reveal
status: proposed
created: 2026-08-19
spec: sidebar-simplification
superseded-by: null
amends: null
---

# 260819-210154. The sidebar boots from a persisted query cache, gated by one boot state and one reveal

## Status

Proposed.

## Context

On every reload the sidebar painted from nothing, then reassembled itself over roughly eight visible beats as five sequential fetches resolved in turn — zone counts, then sections, then Channels and Direct messages, then Agents (initially showing every agent as `'fresh'` because recents were still pending), then recents landing and the Agents list collapsing, then manifests landing last and flipping every agent's name and face. This happened because "pending" and "empty" were the same value everywhere in the sidebar model, and no query cache survived a reload, so there was nothing to paint the first frame with. A persisted cache and an explicit pending state were the two ways to stop the pop-in; the alternative of leaving the sequence as-is and only polishing the empty-state cards was rejected because it does not touch the root cause.

## Decision

We will persist the TanStack Query cache for an allow-listed set of boot queries (config, rooms, threads, mesh agent paths, resolved manifests, recent sessions, team roster) via `@tanstack/react-query-persist-client` plus a sync storage persister, keyed by server origin and busted by app version — web `HttpTransport` only; the Obsidian `DirectTransport` does not persist. `useSidebarState` exposes a `boot: 'cold' | 'warm' | 'settled'` state gated on that full query set, with a 1.5 s timeout and per-query degradation past it; a warm boot paints the final shape on the first frame with no animation, a cold boot shows a geometry-matched skeleton until the gate opens and then cross-fades once.

## Consequences

### Positive

- A returning user's sidebar paints in its final shape on the first frame instead of visibly reassembling itself.
- "Pending" and "empty" are distinct now, so a cold-boot skeleton and per-query degradation become real, testable states instead of an accidental default.
- The `cold | warm | settled` boot-state pattern and the persisted-cache plumbing are reusable by any other client surface that wants the same warm-boot property.

### Negative

- A second cache surface now exists: the persisted `localStorage` snapshot can go stale independently of the live query cache, bounded only by a 24 h `maxAge` and the version buster.
- Two new runtime dependencies (`@tanstack/react-query-persist-client`, `@tanstack/query-sync-storage-persister`) must be kept in lockstep with the existing `@tanstack/react-query` major.
- The 1.5 s boot-gate timeout means a genuinely slow backend still reveals a degraded panel rather than waiting indefinitely — completeness is deliberately traded for responsiveness.

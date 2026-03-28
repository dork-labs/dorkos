---
number: 208
title: Session-Keyed Zustand Store for Chat State
status: draft
created: 2026-03-28
spec: session-state-manager
superseded-by: null
---

# 0208. Session-Keyed Zustand Store for Chat State

## Status

Draft (auto-extracted from spec: session-state-manager)

## Context

The `useChatSession` hook manages all chat state (messages, input, status, errors, streaming metadata, presence) via 15 `useState` and 28 `useRef` declarations. This state is bound to the React component lifecycle — when the user switches sessions, state leaks across sessions, streams cannot run concurrently, and background sessions have no accessible state for indicators.

Prior research (ADR-0005) established Zustand for UI state and TanStack Query for server state. The session chat state is client-only UI state (streaming deltas, input drafts, error banners) that enriches server-confirmed history.

Three approaches were evaluated: (A) inline store with no StreamManager, (B) global Zustand store with StreamManager singleton, (C) Jotai atom families. Approach C was rejected because DorkOS already uses Zustand throughout — introducing a second state library creates split-brain DX.

## Decision

Use a single global Zustand store (`useSessionChatStore`) with `Record<string, SessionState>` keyed by sessionId. The store uses `immer` middleware for ergonomic nested updates and `devtools` in dev only. No `persist` middleware — message content must not be written to localStorage.

The store lives in the entity layer (`entities/session/model/session-chat-store.ts`), following the precedent of `discovery-store.ts`. Session-scoped selectors with `useCallback` ensure cross-session re-render isolation. LRU eviction retains at most 20 sessions, never evicting actively streaming sessions.

## Consequences

### Positive

- Multiple sessions can stream concurrently with isolated state
- Session switching is instant — O(1) store lookup, no loading flash
- Input drafts are preserved per session across switches
- Background sessions are observable (sidebar can read status from store)
- `renameSession` action eliminates the create-on-first-message empty flash
- No new dependencies (Zustand + immer already available)

### Negative

- Dual ownership of messages: TanStack Query holds server-confirmed history, Zustand holds display state. Reconciliation logic required.
- Memory overhead: up to 20 sessions retained in memory (~1MB at peak)
- `immer` performance at streaming rates (~20 events/sec) needs benchmarking
- `devtools` middleware must be disabled in production due to serialization cost

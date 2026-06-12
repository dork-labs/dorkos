---
number: 209
title: Module-Level StreamManager Singleton for Decoupled Stream Lifecycle
status: superseded
created: 2026-03-28
spec: session-state-manager
superseded-by: 264
---

# 0209. Module-Level StreamManager Singleton for Decoupled Stream Lifecycle

## Status

Superseded by ADR-0264 (Server-Owned Durable, Resumable Per-Session Stream (Turn Decoupled from POST)) — the client-owned per-turn stream manager was deleted with the trigger-only POST contract; today's StreamManager owns only the durable connection lifecycle.

## Context

The `useChatSession` hook's `executeSubmission` callback (~200 lines) manages the POST+SSE streaming lifecycle inside React. The `AbortController` lives in a `useRef`, tying stream lifecycle to component lifecycle. When the user switches sessions, the old stream's event callbacks write into the new session's state setters, causing cross-session contamination. Only one session can stream at a time.

The existing codebase has two precedents for module-level service singletons: `SSEConnection` (manages persistent SSE connections outside React) and `AdapterStreamManager` (ADR-0179, centralized relay stream orchestration). Research on StrictMode and HMR (`research/20260327_sse_singleton_strictmode_hmr.md`) confirms that module-level singletons are the correct pattern for long-lived services that must survive React lifecycle.

## Decision

Create a `StreamManager` class as a module-level singleton in the chat feature layer (`features/chat/model/stream-manager.ts`). It manages one `AbortController` per active stream, keyed by sessionId. It calls `transport.sendMessage()` directly and dispatches events to the session chat store via `useSessionChatStore.getState().updateSession()`.

Key design choices:

- Class-based (not function set) — bundles `activeStreams` Map and timer Maps with their manipulation methods
- Module-level singleton — survives React StrictMode double-mount and HMR
- `selectedCwd` passed as parameter to `start()` — avoids circular dependency with `useAppStore`
- Fresh `AbortController` per stream, never reused after `abort()`
- Timer management (4 timer types) moves from React refs to per-session Maps with cleanup in `abort()` and `destroySession()`

## Consequences

### Positive

- Streams survive session switching — switching to session B does not abort session A's stream
- Multiple sessions can stream concurrently with independent AbortControllers
- Stopping a background session works without navigating to it
- Testable independently of React (unit test with mock transport)
- Follows established DorkOS patterns (SSEConnection, AdapterStreamManager)

### Negative

- `executeSubmission` logic (~200 lines) moves from a React callback to a service class — requires careful migration
- `stream-event-handler.ts` needs mechanical signature change (React setState → store actions)
- Timer management in a service class is more verbose than React refs (per-session Maps)
- The singleton must be testable — tests create fresh instances rather than using the module export

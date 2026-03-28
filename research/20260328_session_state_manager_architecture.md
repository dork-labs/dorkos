---
title: 'Session State Manager Architecture — Zustand-Keyed Store + Decoupled StreamManager'
date: 2026-03-28
type: internal-architecture
status: active
tags:
  [
    session-state,
    zustand,
    stream-manager,
    multi-session,
    concurrent-streaming,
    abort-controller,
    session-remap,
    tanstack-query,
    react-19,
    migration,
    memory-management,
  ]
feature_slug: session-state-manager
searches_performed: 8
sources_count: 32
---

# Session State Manager Architecture — Zustand-Keyed Store + Decoupled StreamManager

## Research Summary

This report synthesizes findings from eight existing DorkOS research reports (covering the current
`useChatSession` hook, SSE/streaming patterns, session-remap bugs, TanStack Query + streaming race
conditions, Zustand + React Context patterns, and fetch-based SSE transport) plus eight targeted
web searches to produce a complete architecture recommendation.

The core conclusion: **Approach B (single global Zustand store with a `Map<sessionId, SessionState>`
keyed by session ID, plus a class-based `StreamManager` service that lives outside React)** is
the correct architecture for DorkOS. It solves all four stated problems (multi-session streaming,
instant session switch, background activity indicators, cross-session contamination) with the least
structural rupture to the existing codebase and the best alignment to patterns DorkOS already uses
for its `SSEConnection` singleton and `EventStreamProvider`.

---

## Existing Research — What We Already Know

### From `20260307_relay_streaming_bugs_tanstack_query.md`

**Key finding for this refactor:** Solution D ("Store in-progress streaming messages in Zustand;
only merge into query cache on `done` event") was identified as the architecturally correct
long-term direction, rated "Very high complexity / Multi-day refactor." That assessment is now
the task at hand. The prior research also confirmed:

- The `useChatSession` hook mixes streaming state and history state — intentionally, but this
  creates the race conditions documented there.
- The `statusRef` / `messagesRef` / `selectedCwdRef` ref-sync pattern is already established in
  the codebase and is the right pattern for avoiding stale closures inside async event handlers.
- TanStack Query should own only server-confirmed history snapshots; Zustand (or local state)
  should own the live streaming delta.

### From `20260312_fix_chat_stream_remap_bugs.md`

**Key finding for this refactor:** The session-remap flow (`clientUUID → sdkUUID` on the `done`
event) is already handled by `isRemappingRef`. The key-rename problem in a Zustand Map store can
reuse the same `isRemappingRef` pattern: set the flag synchronously before the `done` handler
fires the `onSessionIdChange` callback, allowing the store to do an atomic key swap from the old
key to the new key without losing in-flight message data.

### From `20260319_streaming_message_integrity_patterns.md`

**Key findings for this refactor:**

- The `client_msg_id` → server-ID remap is the universal industry pattern (Slack, Apollo, RTK Query).
- RTK Query's `onCacheEntryAdded` + `updateCachedData` is the correct structural analogy: the
  streaming handler IS the cache update mechanism, with history fetch doing initial population only.
- Event sourcing on the client is the right long-term target if DorkOS needs multi-stream
  parallel message lists — exactly the capability this refactor enables.

### From `20260306_sse_relay_delivery_race_conditions.md`

**Key findings for this refactor:**

- The `AbortController` per-stream pattern is the correct lifecycle: create on stream start,
  abort on stream cancel or session unmount. Never reuse an aborted controller.
- A service-layer `StreamManager` is analogous to the server-side relay architecture: it publishes
  events to listeners without coupling the publisher to React lifecycle.

### From `20260327_sse_singleton_strictmode_hmr.md`

**Key finding for this refactor:** The exact pattern DorkOS already uses for `SSEConnection` —
a module-level singleton initialized outside React, with React subscribing via `useEffect` or
`useSyncExternalStore` — is the correct model for a `StreamManager`. React StrictMode cannot
double-instantiate a module-level singleton. The `useSyncExternalStore` primitive is the correct
integration point between an external store and React rendering.

### From `20260323_new_session_creation_refactor.md`

**Key finding for this refactor:** The speculative UUID pattern (`?session=<clientUUID>` placed
in the URL before the server session exists) is already in place. The `sessionExistsOnServer`
guard on the history query (`enabled: sessionId !== null && sessionExistsOnServer`) should
propagate to the Zustand store initialization: do not create a store entry for a speculative UUID
until the first message is actually sent.

### From `20260327_fetch_sse_transport_migration.md`

**Key finding for this refactor:** The `AbortController` lifecycle for fetch-based SSE is
one-per-connection: create fresh, never reuse after `abort()`. The `StreamManager`'s per-stream
abort controller follows the same rules — each `sendMessage` call gets its own controller, which
is stored on the session state entry.

---

## Key Findings

### 1. Session-Keyed Zustand Store Patterns

#### `Map<string, SessionState>` vs `Record<string, SessionState>` vs Separate Stores

Three sub-patterns exist for keyed Zustand state:

**A. Flat `Record<string, SessionState>` in one global store** (recommended):

```typescript
interface SessionState {
  messages: ChatMessage[];
  input: string;
  status: 'idle' | 'streaming' | 'error';
  error: TransportErrorInfo | null;
  sessionStatus: SessionStatusEvent | null;
  presenceInfo: PresenceUpdateEvent | null;
  streamStartTime: number | null;
  estimatedTokens: number;
  isTextStreaming: boolean;
  isRateLimited: boolean;
  rateLimitRetryAfter: number | null;
  systemStatus: string | null;
  promptSuggestions: string[];
  presencePulse: boolean;
  sessionBusy: boolean;
  isRemapping: boolean;
}

interface SessionStoreState {
  sessions: Record<string, SessionState>;
  // Actions
  initSession: (sessionId: string) => void;
  destroySession: (sessionId: string) => void;
  renameSession: (oldId: string, newId: string) => void;
  updateSession: (sessionId: string, patch: Partial<SessionState>) => void;
  getSession: (sessionId: string) => SessionState | undefined;
}
```

Using `Record` (plain object with string keys) rather than `Map` is the correct choice for
Zustand because:

- Zustand's `setState` uses shallow merge + `Object.is` comparison; `Map` mutation is not
  detected as a state change by Zustand's default equality.
- `Record` serializes cleanly with `immer` middleware (the recommended approach for nested
  partial updates).
- Selectors on `Record` work naturally with `useShallow` (Zustand v5 API).
- Using a `Map` would require calling `setState` with a new `Map(...)` copy on every update,
  which is more expensive than record spread.

**B. Separate `createStore` per session** (viable but over-engineered for this use case):

This pattern (using Zustand's `createStore` from `zustand/vanilla` + React Context, as described
in tkdodo's "Zustand and React Context" article) is the right tool when:

- Different component subtrees need isolated store instances
- Stores need to be initialized with different props
- Stores must be garbage-collected when the component unmounts

For DorkOS sessions, the component `SessionPage` mounts once globally. Sessions are not components
— they are data domains. Separate stores per session would require a Context provider per session
that mounts/unmounts on navigation, which defeats the goal of background session retention. Do
not use this pattern for session state.

**C. Slices in the existing `useAppStore`** (wrong):

Adding session chat state to the existing `useAppStore` (the global UI store) would couple
ephemeral streaming state to persistent UI state and make the store unwieldy. The session chat
store is a distinct domain and should be a distinct store.

#### Selector Performance with a Keyed Store

The critical performance concern: when session B updates, components displaying session A must
not re-render. The solution is a session-scoped selector:

```typescript
// Single session-scoped selector — only re-renders when this session's state changes
function useSessionState(sessionId: string): SessionState {
  return useSessionStore(
    useCallback((state) => state.sessions[sessionId] ?? DEFAULT_SESSION_STATE, [sessionId])
  );
}

// Granular field selector — only re-renders when this specific field changes
function useSessionMessages(sessionId: string): ChatMessage[] {
  return useSessionStore(
    useCallback((state) => state.sessions[sessionId]?.messages ?? [], [sessionId])
  );
}
```

In Zustand v5, when the selector returns a primitive (string, boolean, number), equality is
`Object.is` — no re-render unless the value changes. When the selector returns an array or object,
wrap in `useShallow` to prevent re-renders when reference changes but content is same:

```typescript
// useShallow prevents re-render when messages array has the same content
const messages = useSessionStore(useShallow((state) => state.sessions[sessionId]?.messages ?? []));
```

`useShallow` performs one-level shallow comparison. For `ChatMessage[]`, this compares message
references — not message content. Since messages are immutable value objects (replaced, not
mutated), this is correct: a new message array with the same references means no content change.

#### Memory Management and Session Eviction

Without eviction, the store grows unbounded as users open sessions. The recommended strategy:

```typescript
// LRU tracking — keep the N most recently accessed sessions in memory
const MAX_RETAINED_SESSIONS = 20;

// In the store: track access order
interface SessionStoreState {
  sessions: Record<string, SessionState>;
  sessionAccessOrder: string[]; // Most recently accessed first
}

// Called whenever a session becomes the active session
function touchSession(sessionId: string): void {
  useSessionStore.setState((state) => {
    const order = [sessionId, ...state.sessionAccessOrder.filter((id) => id !== sessionId)];
    const toEvict = order.slice(MAX_RETAINED_SESSIONS);
    const sessions = { ...state.sessions };
    for (const id of toEvict) {
      if (sessions[id]?.status === 'idle') {
        // Only evict idle sessions — never evict an actively streaming session
        delete sessions[id];
      }
    }
    return {
      sessions,
      sessionAccessOrder: order.filter((id) => id in sessions),
    };
  });
}
```

Sessions that are `status === 'streaming'` must never be evicted — they have an in-flight
`AbortController` and live stream data. The `StreamManager` holds a reference to those anyway,
preventing GC. Evict only `idle` and `error` sessions beyond the retention window.

---

### 2. Decoupled Stream Management

#### StreamManager Service Architecture

The `StreamManager` is a class-based singleton (module-level, like `SSEConnection`) that:

1. Manages one `AbortController` per active stream, keyed by sessionId
2. Calls `transport.sendMessage()` without any React dependency
3. Dispatches stream events directly into the Zustand session store
4. Exposes `start(sessionId, content, options)` and `abort(sessionId)` methods

```typescript
class StreamManager {
  private static instance: StreamManager | null = null;
  private activeStreams = new Map<string, AbortController>();

  static getInstance(): StreamManager {
    if (!StreamManager.instance) {
      StreamManager.instance = new StreamManager();
    }
    return StreamManager.instance;
  }

  async start(
    sessionId: string,
    content: string,
    transport: Transport,
    options: StreamOptions
  ): Promise<void> {
    // Cancel any existing stream for this session
    this.abort(sessionId);

    const abortController = new AbortController();
    this.activeStreams.set(sessionId, abortController);

    // Update store: set streaming status before transport call
    useSessionStore.getState().updateSession(sessionId, {
      status: 'streaming',
      error: null,
    });

    try {
      await transport.sendMessage(
        sessionId,
        content,
        (event) => this.dispatchEvent(sessionId, event),
        abortController.signal,
        options.cwd,
        options.extras
      );
      useSessionStore.getState().updateSession(sessionId, { status: 'idle' });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const errorInfo = classifyTransportError(err);
      useSessionStore.getState().updateSession(sessionId, {
        status: 'error',
        error: errorInfo,
      });
    } finally {
      this.activeStreams.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    this.activeStreams.get(sessionId)?.abort();
    this.activeStreams.delete(sessionId);
  }

  abortAll(): void {
    for (const controller of this.activeStreams.values()) {
      controller.abort();
    }
    this.activeStreams.clear();
  }

  isStreaming(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  private dispatchEvent(sessionId: string, event: StreamEvent): void {
    // Route SSE events to the appropriate store update
    // (extracted from current stream-event-handler.ts)
    const handler = createStreamEventHandler(sessionId);
    handler(event.type, event.data);
  }
}

export const streamManager = StreamManager.getInstance();
```

**Why a class singleton over a module-level function set:**

- The `activeStreams` Map is state that must persist across React renders and session switches.
  A class bundles the state and its manipulation methods together.
- `abortAll()` is a clean teardown method needed when the app unmounts or the transport changes.
- Testing is easier: instantiate a fresh `StreamManager` per test without module cache
  concerns (or use `StreamManager.getInstance()` with a `vi.spyOn` on the transport).

#### AbortController Lifecycle

Exactly one `AbortController` per active stream:

```
sendMessage called for sessionA
  → StreamManager creates AbortController_A
  → stores in activeStreams.set('sessionA', AbortController_A)
  → transport.sendMessage called with AbortController_A.signal
  → streaming events arrive → dispatched to store

User switches to sessionB (sessionA stream still running)
  → StreamManager.start('sessionB', ...) called
  → sessionA stream CONTINUES — no abort
  → AbortController_B created for sessionB stream

User explicitly stops sessionA via Stop button
  → StreamManager.abort('sessionA')
  → AbortController_A.abort()
  → transport.sendMessage rejects with AbortError
  → StreamManager.start catch: AbortError → return silently
  → activeStreams.delete('sessionA')
```

This is the key behavioral difference from the current architecture: the abort is session-scoped,
not component-lifecycle-scoped.

#### Event Dispatch from Service to Zustand Store

The `StreamManager`'s `dispatchEvent` method calls `useSessionStore.getState().updateSession()`
directly. This is the correct pattern for updating Zustand from outside React:

```typescript
// From outside React — always valid in Zustand
useSessionStore.getState().updateSession(sessionId, {
  messages: [...currentMessages, newMessage],
});
```

Zustand's `getState()` is synchronous and does not require a React context. This is the
documented pattern for imperative updates (e.g., from WebSocket handlers, service workers, etc.).
The Zustand store notifies all subscribers (React components) via `useSyncExternalStore`
internally — React batches the re-renders appropriately.

---

### 3. React 19 + Zustand v5 Best Practices

#### `useSyncExternalStore` Under the Hood

Zustand v5 uses `useSyncExternalStore` for all React hooks. This means:

- Selectors are called synchronously during render — no extra render cycle.
- Tearing in concurrent React 19 features is prevented by design.
- StrictMode's double-mount does NOT cause issues for module-level Zustand stores (stores are
  initialized once at module load, not inside React effects).

For the session store, the subscription model is:

```
React component mounts (SessionPage)
  → calls useSessionMessages('sessionA')
  → Zustand subscribes this component to store changes where selector output changes
  → StreamManager updates store['sessionA'].messages
  → Zustand notifies all subscribers whose selector output changed
  → SessionPage re-renders with new messages
  → SessionBadge (background tab indicator) does NOT re-render (its selector: sessions['sessionA'].status,
    which didn't change from 'streaming')
```

#### Preventing Cross-Session Re-renders

The golden rule: **every selector must be scoped to a specific sessionId**. Selectors that read
`state.sessions` (the whole map) will re-render on ANY session update.

```typescript
// BAD — re-renders on any session update
const allSessions = useSessionStore((state) => state.sessions);
const sessionA = allSessions['sessionA'];

// GOOD — re-renders only when sessionA's messages change
const messages = useSessionStore(
  useCallback((state) => state.sessions['sessionA']?.messages ?? [], [])
);
```

For computing derived state (like `activeInteraction`, `isWaitingForUser`) that used to be
computed inside the hook via `useMemo`, these should become selectors or be computed inside
the component with `useMemo` taking the specific session's state as the dependency:

```typescript
// Derived state stays in the component — not in the store
const messages = useSessionMessages(sessionId);
const pendingInteractions = useMemo(
  () =>
    messages
      .flatMap((m) => m.toolCalls ?? [])
      .filter((tc) => tc.interactiveType && tc.status === 'pending'),
  [messages]
);
```

---

### 4. Multi-Session Chat Architecture Patterns

#### Background Activity Indicators

With the session store, implementing per-session activity badges in the sidebar is trivial:

```typescript
function SessionActivityBadge({ sessionId }: { sessionId: string }) {
  // This component only re-renders when THIS session's status changes
  const status = useSessionStore(
    useCallback((state) => state.sessions[sessionId]?.status ?? 'idle', [sessionId])
  );
  const isStreaming = status === 'streaming';

  if (!isStreaming) return null;
  return <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />;
}
```

With the current architecture, this is impossible — `status` only exists inside the `useChatSession`
hook instance that is mounted for the _active_ session. Background sessions have no React hook
instance and therefore no accessible status.

#### "Active Session" vs "Background Sessions"

The distinction is now purely presentational — the store has all sessions' state. The `SessionPage`
component reads the active session's full state for rendering. The sidebar reads only the
`status` field for each session to render activity badges.

#### Unread/Activity Indicators

When a background session receives a `done` event (stream completes), the store can set a flag:

```typescript
// In StreamManager's dispatchEvent, on 'done' event:
const isActiveSession = activeSessionId === sessionId; // From URL/router state
if (!isActiveSession) {
  useSessionStore.getState().updateSession(sessionId, { hasUnseenActivity: true });
}
```

The sidebar badge reads this flag and clears it when the user navigates to that session.

---

### 5. Session Remap (Create-on-First-Message) in a Keyed Store

The remap flow requires renaming a store key atomically:

```
clientUUID → sdkUUID

1. StreamManager's 'done' event handler detects remap (doneData.sessionId !== currentSessionId)
2. Before calling onSessionIdChange:
   - useSessionStore.getState().renameSession(clientUUID, sdkUUID)
   - This copies the SessionState from sessions[clientUUID] to sessions[sdkUUID], then deletes sessions[clientUUID]
3. StreamManager moves the AbortController entry:
   - activeStreams.set(sdkUUID, activeStreams.get(clientUUID))
   - activeStreams.delete(clientUUID)
4. onSessionIdChange fires — URL updates to ?session=sdkUUID
5. Router re-renders SessionPage with new sessionId
6. SessionPage reads sessions[sdkUUID] — data is already there (no empty flash)
```

The `renameSession` action in the store:

```typescript
renameSession: (oldId: string, newId: string) =>
  set((state) => {
    const existing = state.sessions[oldId];
    if (!existing) return state;
    const { [oldId]: _, ...rest } = state.sessions;
    return {
      sessions: {
        ...rest,
        [newId]: { ...existing, isRemapping: false },
      },
      sessionAccessOrder: state.sessionAccessOrder.map((id) => (id === oldId ? newId : id)),
    };
  }),
```

**The empty-flash problem is eliminated entirely.** The store has the message data under the new
key before React re-renders with the new `sessionId`. This is the structural fix for the race
condition analyzed in `20260312_fix_chat_stream_remap_bugs.md`.

---

### 6. Migration Strategy

#### Recommended Migration Path: Parallel Operation

The safest migration is to run the new store alongside `useChatSession` and migrate fields one
at a time, not as a single big-bang rewrite.

**Phase 1: Create the store infrastructure (zero behavior change)**

- Create `useSessionStore` with the `Record<string, SessionState>` shape.
- Create `StreamManager` class (module-level singleton).
- Create `useSessionState(sessionId)` hook that reads from the store.
- Write tests for `StreamManager` (unit) and `useSessionStore` (unit).

No behavior change in `useChatSession`. All new code, no existing code changed.

**Phase 2: Migrate the stream abortController (low risk)**

- Move the `AbortController` from `useChatSession`'s `abortRef` into `StreamManager`.
- `useChatSession`'s `handleSubmit` calls `streamManager.start(...)` instead of
  `transport.sendMessage(...)` directly.
- `StreamManager` still calls back into `useChatSession`'s state setters via the existing
  `streamEventHandler` function.

Behavior change: `stop()` calls `streamManager.abort(sessionId)` instead of
`abortRef.current?.abort()`. Functionally identical for single-session. Multi-session stop
now works correctly (only stops the target session's stream).

**Phase 3: Migrate per-session state fields (medium risk)**

Move fields from `useState` in `useChatSession` to the Zustand session store, one at a time:

- `messages` (highest impact, do last)
- `status` (required for background activity badges)
- `error`
- `sessionBusy`
- `sessionStatus`
- `presenceInfo` / `presencePulse`
- `streamStartTime` / `estimatedTokens` / `isTextStreaming`
- `isRateLimited` / `rateLimitRetryAfter`
- `systemStatus` / `promptSuggestions`

For each field: migrate the store write (in `stream-event-handler.ts` / `executeSubmission`) first,
then migrate the read (in `useChatSession`'s return value, read from store instead of `useState`).

**Phase 4: Migrate `messages` and eliminate `useChatSession` lifecycle**

This is the highest-risk step. `messages` is written by both the history seed effect and the
streaming handler. The migration:

1. Remove the `historySeededRef` + seed `useEffect` from `useChatSession`.
2. The history query result still comes from TanStack Query (`historyQuery`).
3. When `historyQuery.data` updates, write to the session store:

   ```typescript
   useEffect(() => {
     if (!historyQuery.data || sessionId === null) return;
     reconcileTaggedMessages(
       useSessionStore.getState().sessions[sessionId]?.messages ?? [],
       historyQuery.data.messages,
       (updater) => {
         const current = useSessionStore.getState().sessions[sessionId]?.messages ?? [];
         useSessionStore.getState().updateSession(sessionId, {
           messages: typeof updater === 'function' ? updater(current) : updater,
         });
       }
     );
   }, [historyQuery.data, sessionId]);
   ```

4. `StreamManager`'s `dispatchEvent` writes streamed messages directly to the store.

**Phase 5: Thin down `useChatSession` to a selector hook**

After all state is in the store, `useChatSession` becomes:

```typescript
export function useChatSession(sessionId: string | null, options: ChatSessionOptions = {}) {
  const state = useSessionState(sessionId ?? '');
  // ... handlers that call StreamManager + store actions
  return { ...state, handleSubmit, stop, retryMessage, ... };
}
```

The hook can eventually be replaced by a composition of smaller hooks (`useSessionMessages`,
`useSessionStatus`, `useStreamControls`) consumed directly in `SessionPage`. But this is
optional — keeping a `useChatSession` coordinator hook for backward compatibility is fine.

#### Testing Strategy During Migration

Each phase should be gated by tests:

- **Phase 1–2**: Unit tests for `StreamManager` using a `MockTransport` (already exists in
  `@dorkos/test-utils`). Test that `start()`, `abort()`, `abortAll()` work correctly.
- **Phase 3–4**: Update existing `useChatSession` tests incrementally. As fields migrate to the
  store, the test setup changes from `useState` mock to store initialization.
- **Phase 5**: E2E tests using Playwright to verify multi-session streaming behavior. The
  `browser-testing.md` guide documents the patterns for this.

The key test to write before any migration: a test that verifies switching sessions while one
is streaming does NOT abort the background stream. This does not exist today (the behavior is
impossible to achieve with current architecture), and it should be the acceptance test for
the refactor.

---

## Potential Solutions — Three Approaches

### Approach A: Global Zustand Store + Inline Event Dispatch (Minimal Disruption)

**Description:**

Create a single global `useSessionStore` with `Record<string, SessionState>`. Keep `useChatSession`
as the primary hook but replace `useState` calls with store reads/writes. Stream event dispatch
happens inline in the existing `stream-event-handler.ts` by calling
`useSessionStore.getState().updateSession(sessionId, ...)`. No separate `StreamManager` class.

**Architecture sketch:**

```typescript
// stream-event-handler.ts: dispatch directly to store
case 'text_delta': {
  useSessionStore.getState().updateSession(sessionId, (session) => ({
    messages: session.messages.map((m) =>
      m.id === assistantId ? { ...m, content: m.content + delta } : m
    ),
  }));
  break;
}
```

The `AbortController` remains in `useChatSession`'s `abortRef`. No `StreamManager` class.

**Pros:**

- Smallest surface area change — existing `stream-event-handler.ts` and `executeSubmission`
  barely change structurally.
- Incremental: migrate fields one by one without a service layer.
- No new classes or singleton infrastructure.

**Cons:**

- The `AbortController` is still tied to the `useChatSession` hook's `useRef`. When the user
  switches sessions and `useChatSession` remounts with a new `sessionId`, the old `AbortController`
  is lost — its ref is in the unmounted component's closure.
- Actually unmounting is a red herring: `SessionPage` does not unmount on session switch (it
  remounts on `sessionId` change). But the `abortRef` resets to `null` on every `sessionId`
  change effect... which it currently does not (only `historySeededRef` and `messages` are reset).
  So Approach A avoids this problem but leaves the architecture structurally fragile.
- Background streaming activity indicators still require threading `status` up through component
  props or a context from inside `useChatSession`, since `status` would be in the hook instance
  only accessible to the component tree below `SessionPage`.

  Actually, once `status` is in the store (even in Approach A), background indicators work. The
  problem is the AbortController — it's still component-coupled.

- Cannot support two concurrent streams (session A streaming while switching to session B and
  starting session B stream) because there's still only one `AbortController` instance managed
  by the hook.

**Verdict:** Suitable as a quick fix for background activity indicators and cross-session
contamination. Does NOT solve concurrent streaming. Acceptable as Phase 3 interim state.

---

### Approach B: Global Zustand Store + Class-Based StreamManager (Recommended)

**Description:**

Full decoupling: `useSessionStore` holds all session chat state keyed by sessionId. `StreamManager`
is a module-level singleton class that manages all active streams, holds `AbortController`
instances, calls `transport.sendMessage()`, and dispatches events directly to the store.
`useChatSession` becomes a thin coordinator hook that reads from the store and delegates mutations
to `StreamManager`.

**Architecture sketch:**

```
SessionPage
  → useChatSession('sessionA')
      → reads: useSessionStore((s) => s.sessions['sessionA'])
      → writes: streamManager.start('sessionA', ...) on submit
                useSessionStore.getState().updateSession('sessionA', ...) on input change

Background:
  StreamManager
    → activeStreams: Map { 'sessionA' => AbortController_A, 'sessionB' => AbortController_B }
    → transport.sendMessage('sessionA', ...) → stream events → store.updateSession('sessionA', ...)
    → transport.sendMessage('sessionB', ...) → stream events → store.updateSession('sessionB', ...)
```

**Pros:**

- Concurrent streaming: multiple sessions can stream simultaneously because each has its own
  `AbortController` in `StreamManager`.
- Instant session switch: switching to session B reads from the store — no re-fetch, no loading
  state (messages are already in memory if session B was recently active).
- Background activity indicators: sidebar reads `sessions[id].status` for each session — trivial.
- Cross-session contamination eliminated: each session's state is completely isolated in the store.
- Remap is atomic: `renameSession(clientUUID, sdkUUID)` swaps the key without data loss.
- Aligns with existing DorkOS patterns: `SSEConnection` singleton, `EventStreamProvider` singleton.
  `StreamManager` is the same architectural tier.
- Testable: `StreamManager` can be unit-tested with a mock transport, independent of React.

**Cons:**

- Largest upfront structural change: requires the `StreamManager` class and the full store shape.
- `stream-event-handler.ts` needs to call `useSessionStore.getState().updateSession(...)` instead
  of `setState` calls. This is a mechanical change but touches every event type.
- `executeSubmission` in `useChatSession` is the most complex callback (~200 lines). Refactoring
  it to delegate to `StreamManager` requires threading `sessionId` through every path.
- Timers (`sessionBusyTimerRef`, `systemStatusTimerRef`, etc.) move from React refs to class-level
  `Map<sessionId, NodeJS.Timeout>` in `StreamManager`. Not hard, but verbose.

**Migration risk:** Medium-high for the full refactor. Low for incremental phases 1-2.

**Verdict:** The correct long-term architecture. Implement via the phased migration described above.

---

### Approach C: Jotai Atom Family (Maximum Granularity, Maximum Complexity)

**Description:**

Replace Zustand entirely with Jotai. Use `atomFamily(sessionId => atom(defaultState))` to create
a per-session atom automatically. Each session's state is a separate atom; components only
subscribe to the atoms they use. `StreamManager` can write to atoms via the Jotai store API
(`store.set(sessionAtom(sessionId), updater)`).

**Architecture sketch:**

```typescript
import { atomFamily, atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

const sessionStateAtom = atomFamily((sessionId: string) => atom<SessionState>(defaultSessionState));

const sessionMessagesAtom = atomFamily((sessionId: string) =>
  atom((get) => get(sessionStateAtom(sessionId)).messages)
);
```

**Pros:**

- Finest granularity: components that only need `messages` don't re-render when `status` changes.
- Atom families handle the "create on first access" pattern natively.
- Session eviction is `sessionStateAtom.remove(sessionId)`.
- TypeScript inference for atoms is excellent.
- `atomFamily` is designed for exactly this use case — per-instance state keyed by a dynamic ID.

**Cons:**

- DorkOS already uses Zustand throughout (`useAppStore`, existing chat state migration). Introducing
  a second state library is a significant DX and DX coherence cost.
- Jotai's Jotai store API (`import { createStore } from 'jotai'`) for writing from outside React
  is less documented and less battle-tested than Zustand's `getState().setState()` pattern.
- The Jotai `atomFamily` garbage collection story is complex: atoms accumulate unless explicitly
  removed. LRU eviction requires additional bookkeeping outside the atom family itself.
- The `subscribeWithSelector` equivalent in Jotai is `store.sub(atom, callback)` — less ergonomic
  than Zustand's equivalent for the `StreamManager`'s needs.
- The `useShallow` + `useCallback` selector patterns that make Zustand v5 ergonomic don't directly
  apply to Jotai (though Jotai has equivalent optimizations).
- Migrating from Zustand to Jotai in one feature while leaving `useAppStore` on Zustand creates
  a split-brain state management architecture that future developers will find confusing.

**Verdict:** Architecturally sound but wrong for DorkOS because it introduces a second state
library. If DorkOS were starting fresh, Jotai's atom family would be the ideal choice. Given
the existing Zustand investment, stick with Zustand.

---

## Security Considerations

- The `StreamManager` holds `AbortController` instances per session. If a component passes a
  forged `sessionId`, it could abort another session's stream. The `StreamManager` should validate
  that the caller is authorized to abort the target session. For a single-user app, this is an
  internal consistency concern (not a cross-user security risk), but defensive checks are still
  worthwhile: `abort(sessionId)` should be a no-op if `sessionId` does not correspond to an
  active stream.

- Session state in the store contains full message content. The store is module-level global state.
  Do NOT add `persist` middleware to the session store — message content should not be written to
  `localStorage`. The existing `useAppStore` uses persistence; the session store must not.

- The `StreamManager` calls `transport.sendMessage` directly. The transport already handles
  authentication (via `X-Client-Id` and the existing auth mechanisms). No new auth surface is
  introduced.

---

## Performance Considerations

1. **Store size**: With `MAX_RETAINED_SESSIONS = 20` and an average of 50 messages per session
   at ~1KB per message, the store holds ~1MB of message data at peak. This is acceptable for a
   developer tool running in a dedicated browser tab.

2. **Re-render isolation**: With session-scoped selectors and `useShallow`, a stream update to
   session B causes exactly zero re-renders in components displaying session A.

3. **TanStack Query cache + Zustand store duplication**: The history query (TanStack Query) and
   the session messages (Zustand store) will overlap during and after seeding. This is intentional:
   - TanStack Query is the source of truth for _server-confirmed history_ (fetch, cache,
     invalidate on `sync_update`).
   - The Zustand store is the source of truth for _display state_ (includes optimistic messages,
     streaming deltas, client-only parts like errors and hook states).
   - After seeding, the store's `messages` array diverges from the query cache because the store
     includes client-only parts. This is correct — the server doesn't know about `_streaming`
     flags or client-generated IDs.

4. **`immer` middleware**: Recommended for the session store. The `messages` array is deeply
   nested, and `immer` makes partial updates ergonomic without excessive object spread. The
   performance cost of `immer` is negligible for arrays of <1000 messages (the relevant size
   for a single session). Enable it via:

   ```typescript
   import { immer } from 'zustand/middleware/immer';
   const useSessionStore = create<SessionStoreState>()(immer((set) => ({ ... })));
   ```

5. **`devtools` middleware**: Add in development only, not production. The devtools middleware
   serializes the entire store state on every update — with streaming deltas arriving at
   ~20 events/second and multiple concurrent sessions, this is expensive in production.

---

## Migration Risk Assessment

| Phase                                | Risk   | Mitigation                                                                          |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------- |
| Phase 1: Store + StreamManager infra | Low    | Pure addition; no existing code changes                                             |
| Phase 2: AbortController migration   | Low    | `stop()` is a simple passthrough; existing tests cover it                           |
| Phase 3: Status + simple fields      | Medium | Each field migrated independently; snapshot tests catch regressions                 |
| Phase 4: Messages migration          | High   | The `historySeededRef` + reconcile logic is the most complex; needs careful testing |
| Phase 5: Thin useChatSession         | Low    | Structural cleanup after all state is migrated; no behavior change                  |

**Highest-risk scenario:** The `isRemappingRef` remap flow is the most complex timing-sensitive
code path. During Phase 4 (messages migration), the `renameSession` store action must be called
BEFORE the React `sessionId` state updates (just as `isRemappingRef.current = true` is set before
`onSessionIdChange` fires today). If this ordering is violated, React will re-render with the new
`sessionId` before the store has the data under that key, causing an empty flash. The fix: call
`useSessionStore.getState().renameSession(oldId, newId)` synchronously in the `done` handler,
then call `onSessionIdChange(newId)`. This is the same pattern as the current `isRemappingRef`
solution, just expressed as a store mutation.

**Recommended safeguard:** Write the acceptance test for session-switch-during-streaming BEFORE
starting Phase 2. Make the test red first, then green after Phase 2. Keep it green through all
subsequent phases.

---

## Recommendation

**Implement Approach B (Global Zustand Store + StreamManager) via the five-phase migration.**

**Rationale:**

1. **Aligns with DorkOS architecture**: The `StreamManager` singleton is identical in tier and
   lifecycle to the existing `SSEConnection` singleton. DorkOS already knows how to build and
   test this pattern.

2. **Solves all four stated problems completely**: Concurrent streaming (Phase 2), instant session
   switch (Phase 3–4), background indicators (Phase 3), cross-session contamination (Phase 3).

3. **Lowest risk via phased delivery**: Each phase ships independently and is fully tested before
   the next begins. Phases 1–2 can ship as a single PR. Phases 3–4 are the core refactor. Phase 5
   is cleanup.

4. **Doesn't introduce new dependencies**: Zustand is already used. No Jotai, no Valtio, no Recoil.

5. **The `renameSession` action cleanly solves the remap empty-flash**, which has been an open
   bug since the remap was introduced and is the most user-visible artifact of the current
   component-coupled architecture.

**Caveats:**

- The `stream-event-handler.ts` currently uses a factory function that receives React `setState`
  callbacks. After migration, it needs to call `useSessionStore.getState().updateSession()` instead.
  This is a significant but mechanical refactor of that file — every `setMessages`, `setStatus`,
  `setError`, etc. call becomes a store update. Plan for ~2-4 hours of careful work here.

- The `selectedCwd` value is currently read from `useAppStore` inside `useChatSession`. The
  `StreamManager` needs access to `selectedCwd` to pass to `transport.sendMessage`. The correct
  approach: pass `selectedCwd` as a parameter to `streamManager.start(...)` (read from the store
  at call time via `useAppStore.getState().selectedCwd`). Do NOT have `StreamManager` import
  `useAppStore` directly — that creates a circular dependency between the two stores. Pass cwd
  as a parameter.

- Timer cleanup (`sessionBusyTimerRef`, `systemStatusTimerRef`, `presencePulseTimerRef`) currently
  runs in a `useChatSession` unmount effect. After migration, these timers move to `StreamManager`
  (for streaming-related timers) and to store actions (for UI timers). Make sure the eviction
  path (`destroySession`) also clears any pending timers for that session.

---

## Sources & Evidence

### Existing DorkOS Research

- `research/20260307_relay_streaming_bugs_tanstack_query.md` — Solution D (Zustand for streaming
  state) identified; analysis of `useChatSession` architecture flaws
- `research/20260312_fix_chat_stream_remap_bugs.md` — `isRemappingRef` pattern; remap timing
  analysis; `setMessages([])` call before `onSessionIdChange`
- `research/20260319_streaming_message_integrity_patterns.md` — RTK Query `onCacheEntryAdded`
  pattern; Slack `client_msg_id` reconciliation; event sourcing tradeoffs
- `research/20260306_sse_relay_delivery_race_conditions.md` — AbortController per-connection
  pattern; service-layer publishing architecture
- `research/20260327_sse_singleton_strictmode_hmr.md` — Module-level singleton pattern for
  long-lived services; `useSyncExternalStore` integration; `useAppStore` as model
- `research/20260327_fetch_sse_transport_migration.md` — AbortController lifecycle (create fresh
  per stream, never reuse); `reader.releaseLock()` in finally block
- `research/20260323_new_session_creation_refactor.md` — Speculative UUID pattern; `enabled`
  guard on history query for pre-creation window
- `research/20260316_multi_client_session_indicator.md` — Background activity badge patterns;
  `StatusLine.Item` with `visible={clientCount > 1}`

### External Sources

- [Zustand and React Context - tkdodo.eu](https://tkdodo.eu/blog/zustand-and-react-context) —
  `createStore` + Context for per-instance stores; when module singletons are appropriate
- [Selectors & Re-rendering - Zustand DeepWiki](https://deepwiki.com/pmndrs/zustand/2.3-selectors-and-re-rendering) —
  `useShallow` for Map-keyed selectors; `subscribeWithSelector` middleware
- [GitHub pmndrs/zustand](https://github.com/pmndrs/zustand) — `getState()` for imperative
  out-of-React updates; Zustand v5 `useSyncExternalStore` internals
- [React Context: Managing Multi-Instance Contexts Using Zustand](https://tuffstuff9.hashnode.dev/react-context-managing-single-and-multi-instance-contexts-using-zustand) —
  multiple chatbox instances with isolated context stores
- [Avoid performance issues when using Zustand - DEV Community](https://dev.to/devgrana/avoid-performance-issues-when-using-zustand-12ee) —
  specific selector patterns for Map-keyed state performance
- [Best practices on using selectors in v5 - Zustand Discussion](https://github.com/pmndrs/zustand/discussions/2867) —
  `useCallback` + selector stability in v5
- [Concurrent Optimistic Updates in React Query - tkdodo.eu](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query) —
  `isMutating() === 1` guard for multi-stream invalidation
- [RTK Query streaming updates - Redux Toolkit](https://redux-toolkit.js.org/rtk-query/usage/streaming-updates) —
  `onCacheEntryAdded` as the correct structural model

---

## Research Gaps & Limitations

- **Zustand v5 immer middleware performance with streaming**: No benchmarks exist for the cost
  of `immer`-patching a large `messages[]` array at ~20 events/second (typical text streaming
  rate). If performance testing reveals this is a bottleneck, replace `immer` with manual spread
  for the `messages` update path and keep `immer` for other fields.

- **`StreamManager` and the Obsidian plugin (DirectTransport)**: The `DirectTransport` (in-process
  for Obsidian) is not an HTTP transport and does not use SSE. Whether it supports concurrent
  streaming has not been researched. The `StreamManager` abstracts transport calls, so it should
  work with `DirectTransport` — but this needs verification during Phase 2.

- **Zustand store DevTools ergonomics with a large Map-keyed store**: Zustand DevTools serializes
  the entire state on every update. With 20 sessions × 50 messages each, this is a non-trivial
  serialization cost. The `devtools` middleware's `serialize` option can be used to truncate
  message content in DevTools output without affecting actual state.

- **`useShallow` performance with large `messages[]` arrays**: `useShallow` performs a one-level
  comparison of array elements. For a `ChatMessage[]` of 200+ messages, this is O(N) on every
  store update. The selector should be further scoped where possible (e.g., render only the last
  N messages if the virtualizer already handles windowing).

---

## Contradictions & Disputes

- **"Zustand is for UI state; TanStack Query is for server state"** vs. **"messages should be in
  Zustand"**: Standard guidance says to use TanStack Query for server-fetched data and Zustand for
  UI state. The `messages` array in DorkOS is a hybrid: it starts as server history (from TanStack
  Query) but gains client-only parts (streaming deltas, error states, tool call UI state) that the
  server cannot provide. The resolution: TanStack Query retains ownership of the _server history
  snapshot_ (the query cache entry). Zustand owns the _display messages_ (the merged, enriched
  display array). They coexist with a one-way sync: history updates flow into the Zustand store
  via a `useEffect` that calls `reconcileTaggedMessages`. This is the same dual-ownership model
  used by RTK Query's `onCacheEntryAdded` pattern.

- **"Module-level singleton StreamManager" vs. "per-component lifecycle"**: The standard React
  recommendation is to manage async resources in `useEffect`. The `SSEConnection` research
  (`20260327_sse_singleton_strictmode_hmr.md`) conclusively demonstrates that long-lived services
  must live outside React to survive StrictMode and HMR. The `StreamManager` is a long-lived
  service. It belongs at module scope.

---

## Search Methodology

- Searches performed: 8
- Most productive search terms: "zustand createStore vanilla multiple instances context provider React pattern 2025",
  "zustand selector Map sessionId re-render performance useShallow subscribeWithSelector 2025",
  "background streaming service class singleton Zustand dispatch events React chat app architecture",
  "session state manager zustand map eviction memory management LRU chat sessions frontend architecture"
- Primary sources: tkdodo.eu, zustand.docs.pmnd.rs, Zustand GitHub discussions, existing DorkOS
  research reports, RTK Query docs
- Existing DorkOS research re-used: 8 reports (no new web research needed for >70% of findings)

---
slug: session-state-manager
number: 190
created: 2026-03-28
status: draft
authors: Claude Code
ideation: specs/session-state-manager/01-ideation.md
---

# Session State Manager

## Status

Draft

## Overview

Decouple session chat state from React component lifecycle into a session-keyed Zustand store with an independent `StreamManager` singleton service. This enables multiple concurrent streaming sessions, instant session resume on switch, per-session input draft preservation, full-spectrum background activity indicators, and structurally eliminates cross-session state contamination.

## Background / Problem Statement

The `useChatSession` hook (670 lines) manages all chat state via 15 `useState` declarations and 28 `useRef` declarations. This state is tightly bound to the React component lifecycle:

1. **Cross-session contamination**: When switching sessions, `input`, `promptSuggestions`, `error`, `sessionBusy`, and other transient state leaked from the old session to the new one. A tactical `useEffect` fix was applied but does not address the root cause.

2. **No concurrent streaming**: Only one session can stream at a time. The `AbortController` lives in a `useRef` inside the hook — switching sessions while streaming loses the controller reference, and the old stream's event callbacks write into the new session's state setters.

3. **No instant resume**: Switching away from a streaming session and back requires a full history reload from the server. There is no client-side state persistence across session switches.

4. **No background indicators**: The sidebar cannot show which sessions are streaming, errored, or awaiting tool approval because `status` only exists inside the mounted `useChatSession` hook instance.

Prior research (`research/20260307_relay_streaming_bugs_tanstack_query.md`) identified "Zustand for streaming state" (Solution D) as the correct long-term direction. This spec implements that direction.

## Goals

- Multiple sessions can stream concurrently without interference
- Switching sessions is instant — messages and state are already in the store
- Input drafts are preserved per session across switches (like browser tabs)
- Background sessions show streaming/error/tool-approval indicators in sidebar
- Session remap (create-on-first-message, clientUUID → sdkUUID) has no empty flash
- Stopping a background session works without navigating to it
- `useChatSession`'s public return interface remains identical — zero consumer changes
- `useChatSession` shrinks from ~670 to ~300 lines

## Non-Goals

- Server-side streaming protocol changes (client-only refactor)
- Cross-tab state sync (already handled by cross-client sync SSE)
- Obsidian plugin `DirectTransport` refactoring (verify compatibility only)
- Full rewrite of `stream-event-handler.ts` event types (mechanical signature change only)
- TanStack Pacer adoption for timer management (follow-up spec)
- Replacing `useAppStore`'s session status flags (`isStreaming`, `isTextStreaming`, `isWaitingForUser`, `activeForm`) — `useChatStatusSync` continues to bridge these

## Technical Dependencies

- **Zustand** `^5.0.0` (already installed in `apps/client/package.json`)
- **Zustand immer middleware** (`zustand/middleware/immer`) — bundled with Zustand 5.x, no new dependency
- **Zustand devtools middleware** (`zustand/middleware`) — already used by `discovery-store.ts`
- **TanStack Query** `^5.62.0` (already installed) — retains ownership of server-confirmed history
- **Transport interface** (`@dorkos/shared/transport`) — unchanged, `sendMessage()` accepts `onEvent` callback

No new npm dependencies.

## Detailed Design

### Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  React Layer                                                      │
│                                                                    │
│  SessionPage ──► useChatSession(sessionId) ──► ChatPanel          │
│       │              │  reads from store                           │
│       │              │  delegates submit/stop to StreamManager     │
│       │              │  manages sync SSE + history seeding         │
│       │              ▼                                             │
│  SessionItem ──► useSessionChatStore (selectors)                  │
│       │              │  reads status for activity indicators       │
│       │              ▼                                             │
│  useChatStatusSync ──► useAppStore (bridges to global flags)      │
└──────────────────┬───────────────────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────────────────┐
│  Service Layer (module-scope, outside React)                      │
│                                                                    │
│  StreamManager (singleton)                                         │
│  ├── activeStreams: Map<sessionId, AbortController>                │
│  ├── timers: Map<sessionId, SessionTimers>                        │
│  ├── start(sessionId, content, transport, opts) ──► POST stream   │
│  ├── abort(sessionId)                                              │
│  ├── abortAll()                                                    │
│  ├── isStreaming(sessionId) → boolean                              │
│  ├── getActiveSessionIds() → string[]                              │
│  └── dispatchEvent(sessionId, event) ──► store.updateSession()    │
└──────────────────┬───────────────────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────────────────┐
│  State Layer                                                      │
│                                                                    │
│  useSessionChatStore (Zustand, entity layer)                      │
│  ├── sessions: Record<string, SessionState>                       │
│  ├── sessionAccessOrder: string[]  (LRU tracking)                 │
│  ├── initSession(id)                                               │
│  ├── destroySession(id)                                            │
│  ├── renameSession(oldId, newId)                                   │
│  ├── updateSession(id, patch)                                      │
│  └── touchSession(id)  (LRU eviction)                             │
│                                                                    │
│  TanStack Query Cache (server-confirmed history)                  │
│  └── ['messages', sessionId, cwd] → server snapshot               │
└──────────────────────────────────────────────────────────────────┘
```

### SessionState Shape

```typescript
/** Per-session chat state stored in the session chat store. */
interface SessionState {
  // --- Message state ---
  messages: ChatMessage[];
  currentParts: MessagePart[];
  orphanHooks: Map<string, HookPart[]>;
  assistantId: string;
  assistantCreated: boolean;
  pendingUserId: string | null;

  // --- Input & status ---
  input: string;
  status: ChatStatus; // 'idle' | 'streaming' | 'error'
  error: TransportErrorInfo | null;
  sessionBusy: boolean;

  // --- Streaming metadata ---
  streamStartTime: number | null;
  estimatedTokens: number;
  isTextStreaming: boolean;
  thinkingStart: number | null;

  // --- Session metadata ---
  sessionStatus: SessionStatusEvent | null;
  rateLimitRetryAfter: number | null;
  isRateLimited: boolean;
  systemStatus: string | null;
  promptSuggestions: string[];

  // --- Presence ---
  presenceInfo: PresenceUpdateEvent | null;
  presencePulse: boolean;

  // --- Lifecycle flags ---
  historySeeded: boolean;
  retryCount: number;
  isRemapping: boolean;

  // --- Background activity ---
  hasUnseenActivity: boolean;
}
```

### Session Chat Store (`entities/session/model/session-chat-store.ts`)

Follows the entity-layer store pattern established by `discovery-store.ts`:

```typescript
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

const MAX_RETAINED_SESSIONS = 20;

const DEFAULT_SESSION_STATE: SessionState = {
  messages: [],
  currentParts: [],
  orphanHooks: new Map(),
  assistantId: '',
  assistantCreated: false,
  pendingUserId: null,
  input: '',
  status: 'idle',
  error: null,
  sessionBusy: false,
  streamStartTime: null,
  estimatedTokens: 0,
  isTextStreaming: false,
  thinkingStart: null,
  sessionStatus: null,
  rateLimitRetryAfter: null,
  isRateLimited: false,
  systemStatus: null,
  promptSuggestions: [],
  presenceInfo: null,
  presencePulse: false,
  historySeeded: false,
  retryCount: 0,
  isRemapping: false,
  hasUnseenActivity: false,
};

interface SessionChatStoreState {
  sessions: Record<string, SessionState>;
  sessionAccessOrder: string[];
}

interface SessionChatStoreActions {
  initSession: (sessionId: string) => void;
  destroySession: (sessionId: string) => void;
  renameSession: (oldId: string, newId: string) => void;
  updateSession: (sessionId: string, patch: Partial<SessionState>) => void;
  touchSession: (sessionId: string) => void;
  getSession: (sessionId: string) => SessionState;
}
```

Key implementation details:

- **`initSession`**: Creates entry with `DEFAULT_SESSION_STATE` if not present. Calls `touchSession`.
- **`destroySession`**: Removes session from `sessions` and `sessionAccessOrder`.
- **`renameSession`**: Atomic key swap — copies state from `oldId` to `newId`, removes `oldId`, updates `sessionAccessOrder`. Called synchronously in the `done` handler before `onSessionIdChange` fires.
- **`updateSession`**: Shallow merges `patch` into `sessions[sessionId]` via immer. Initializes session if not present.
- **`touchSession`**: Moves `sessionId` to front of `sessionAccessOrder`. Evicts idle sessions beyond `MAX_RETAINED_SESSIONS`.
- **`getSession`**: Returns `sessions[sessionId] ?? DEFAULT_SESSION_STATE`.

**LRU eviction** in `touchSession`:

```typescript
touchSession: (sessionId) =>
  set((state) => {
    const order = [sessionId, ...state.sessionAccessOrder.filter((id) => id !== sessionId)];
    const toEvict = order.slice(MAX_RETAINED_SESSIONS);
    for (const id of toEvict) {
      if (state.sessions[id]?.status === 'idle') {
        delete state.sessions[id];
      }
    }
    state.sessionAccessOrder = order.filter((id) => id in state.sessions);
  }, false, 'session-chat/touchSession'),
```

**Selector hooks** (exported from barrel):

```typescript
/** Session-scoped selector — only re-renders when this session's state changes. */
function useSessionChatState(sessionId: string): SessionState {
  return useSessionChatStore(
    useCallback((s) => s.sessions[sessionId] ?? DEFAULT_SESSION_STATE, [sessionId])
  );
}

/** Granular field selectors for re-render isolation. */
function useSessionMessages(sessionId: string): ChatMessage[] {
  return useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.messages ?? [], [sessionId])
  );
}

function useSessionStatus(sessionId: string): ChatStatus {
  return useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.status ?? 'idle', [sessionId])
  );
}
```

**Middleware stack**: `immer` for ergonomic nested updates + `devtools` in dev only (controlled by `import.meta.env.DEV`). No `persist` middleware — message content must not be written to localStorage.

### StreamManager (`features/chat/model/stream-manager.ts`)

Module-level singleton class, following the pattern of `SSEConnection` and `AdapterStreamManager` (ADR-0179):

```typescript
interface StreamOptions {
  cwd?: string;
  clientMessageId?: string;
  uiState?: UiState;
  transformContent?: (content: string) => string | Promise<string>;
  onSessionIdChange?: (newId: string) => void;
  onStreamingDone?: () => void;
  onTaskEvent?: (event: TaskUpdateEvent) => void;
}

class StreamManager {
  private activeStreams = new Map<string, AbortController>();
  private timers = new Map<string, SessionTimers>();

  async start(
    sessionId: string,
    content: string,
    transport: Transport,
    options: StreamOptions
  ): Promise<void> {
    // 1. Abort any existing stream for this session
    this.abort(sessionId);

    // 2. Create new AbortController
    const controller = new AbortController();
    this.activeStreams.set(sessionId, controller);

    // 3. Initialize store state for streaming
    const store = useSessionChatStore.getState();
    store.updateSession(sessionId, {
      status: 'streaming',
      error: null,
      retryCount: 0,
      currentParts: [],
      assistantId: crypto.randomUUID(),
      assistantCreated: false,
      streamStartTime: Date.now(),
      estimatedTokens: 0,
    });

    // 4. Add optimistic user message
    // ... (mirrors current executeSubmission logic)

    // 5. Call transport.sendMessage with event handler
    try {
      await transport.sendMessage(
        sessionId,
        content,
        (event) => this.dispatchEvent(sessionId, event, options),
        controller.signal,
        options.cwd,
        { clientMessageId: options.clientMessageId, uiState: options.uiState }
      );
      store.updateSession(sessionId, { status: 'idle' });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      // ... error handling, retry logic (mirrors current executeSubmission)
    } finally {
      this.activeStreams.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    this.activeStreams.get(sessionId)?.abort();
    this.activeStreams.delete(sessionId);
    this.clearTimers(sessionId);
  }

  abortAll(): void {
    for (const [id, controller] of this.activeStreams) {
      controller.abort();
      this.clearTimers(id);
    }
    this.activeStreams.clear();
  }

  isStreaming(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  getActiveSessionIds(): string[] {
    return [...this.activeStreams.keys()];
  }

  private dispatchEvent(sessionId: string, event: StreamEvent, options: StreamOptions): void {
    // Routes SSE events to store updates.
    // Refactored from createStreamEventHandler — same event types,
    // but writes to useSessionChatStore.getState().updateSession()
    // instead of React setState callbacks.
  }

  private clearTimers(sessionId: string): void {
    const timers = this.timers.get(sessionId);
    if (!timers) return;
    clearTimeout(timers.textStreaming);
    clearTimeout(timers.systemStatus);
    clearTimeout(timers.sessionBusy);
    clearTimeout(timers.presencePulse);
    this.timers.delete(sessionId);
  }
}

export const streamManager = new StreamManager();
```

**Remap handling** in `dispatchEvent` for the `done` event:

```typescript
case 'done': {
  if (doneData.sessionId && doneData.sessionId !== sessionId) {
    // Atomic key swap BEFORE URL update
    useSessionChatStore.getState().renameSession(sessionId, doneData.sessionId);
    // Move AbortController entry
    const controller = this.activeStreams.get(sessionId);
    if (controller) {
      this.activeStreams.set(doneData.sessionId, controller);
      this.activeStreams.delete(sessionId);
    }
    // Fire URL update — React re-renders, reads from new key, data already there
    options.onSessionIdChange?.(doneData.sessionId);
  }
}
```

**Background activity tracking**: When a background session's stream completes (`done` event), check if it's the active session. If not, set `hasUnseenActivity: true`:

```typescript
const activeSessionId = /* read from router/URL state */;
if (sessionId !== activeSessionId) {
  store.updateSession(sessionId, { hasUnseenActivity: true });
}
```

### Refactored `useChatSession` Hook

The hook becomes a thin coordinator (~300 lines):

```typescript
export function useChatSession(sessionId: string | null, options: ChatSessionOptions = {}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const selectedCwd = useAppStore((s) => s.selectedCwd);

  // Read from session chat store
  const sessionState = useSessionChatState(sessionId ?? '');

  // Touch session for LRU tracking
  useEffect(() => {
    if (sessionId) {
      useSessionChatStore.getState().touchSession(sessionId);
    }
  }, [sessionId]);

  // Clear unseen activity flag when session becomes active
  useEffect(() => {
    if (sessionId && sessionState.hasUnseenActivity) {
      useSessionChatStore.getState().updateSession(sessionId, { hasUnseenActivity: false });
    }
  }, [sessionId, sessionState.hasUnseenActivity]);

  // History seeding from TanStack Query into store
  const historyQuery = useQuery({
    queryKey: ['messages', sessionId, selectedCwd],
    queryFn: () => transport.getMessages(sessionId!, selectedCwd ?? undefined),
    enabled: sessionId !== null,
    // ... existing query config
  });

  useEffect(() => {
    if (!historyQuery.data || !sessionId) return;
    const store = useSessionChatStore.getState();
    const session = store.getSession(sessionId);
    if (!session.historySeeded && historyQuery.data.messages.length > 0) {
      if (session.status === 'streaming') return; // Defer until stream completes
      store.updateSession(sessionId, {
        messages: historyQuery.data.messages.map(mapHistoryMessage),
        historySeeded: true,
      });
      return;
    }
    if (session.historySeeded && session.status !== 'streaming') {
      reconcileTaggedMessages(session.messages, historyQuery.data.messages, (updater) => {
        const current = store.getSession(sessionId).messages;
        store.updateSession(sessionId, {
          messages: typeof updater === 'function' ? updater(current) : updater,
        });
      });
    }
  }, [historyQuery.data, sessionId]);

  // Cross-client sync SSE (stays in hook — needs sessionId reactivity)
  const syncUrl = useMemo(() => {
    if (!sessionId || sessionState.status === 'streaming' || !enableCrossClientSync) return null;
    return `/api/sessions/${sessionId}/stream?clientId=${transport.clientId}`;
  }, [sessionId, sessionState.status, enableCrossClientSync, transport.clientId]);

  // ... syncEventHandlers, useSSEConnection (unchanged)

  // Submit delegates to StreamManager
  const handleSubmit = useCallback(async () => {
    if (!sessionState.input.trim() || sessionState.status === 'streaming') return;
    const content = sessionState.input.trim();
    useSessionChatStore.getState().updateSession(sessionId!, { input: '' });
    await streamManager.start(sessionId!, content, transport, {
      cwd: selectedCwd ?? undefined,
      transformContent: options.transformContent,
      onSessionIdChange: options.onSessionIdChange,
      onStreamingDone: options.onStreamingDone,
      onTaskEvent: options.onTaskEvent,
    });
  }, [sessionId, sessionState.input, sessionState.status, transport, selectedCwd, options]);

  // Stop delegates to StreamManager
  const stop = useCallback(() => {
    if (sessionId) streamManager.abort(sessionId);
    useSessionChatStore.getState().updateSession(sessionId!, { status: 'idle' });
  }, [sessionId]);

  // setInput writes to store
  const setInput = useCallback(
    (value: string) => {
      if (sessionId) {
        useSessionChatStore.getState().updateSession(sessionId, { input: value });
      }
    },
    [sessionId]
  );

  // Derived state (computed from store, not stored)
  const pendingInteractions = useMemo(() => {
    return sessionState.messages
      .flatMap((m) => m.toolCalls || [])
      .filter((tc) => tc.interactiveType && tc.status === 'pending');
  }, [sessionState.messages]);

  const activeInteraction = pendingInteractions[0] || null;

  // Return identical interface
  return {
    messages: sessionState.messages,
    input: sessionState.input,
    setInput,
    handleSubmit,
    status: sessionState.status,
    error: sessionState.error,
    sessionBusy: sessionState.sessionBusy,
    stop,
    // ... all other properties from sessionState
    // Derived state
    isWaitingForUser: activeInteraction !== null,
    waitingType: activeInteraction?.interactiveType || null,
    activeInteraction,
    // ... remaining return values unchanged
  };
}
```

### Background Activity Indicators (`SessionItem.tsx`)

Add per-session status indicators by reading from the store:

```typescript
function SessionActivityIndicator({ sessionId }: { sessionId: string }) {
  const status = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.status ?? 'idle', [sessionId])
  );
  const hasUnseenActivity = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.hasUnseenActivity ?? false, [sessionId])
  );
  const isWaitingForUser = useSessionChatStore(
    useCallback((s) => {
      const msgs = s.sessions[sessionId]?.messages ?? [];
      return msgs.some((m) =>
        m.toolCalls?.some((tc) => tc.interactiveType && tc.status === 'pending')
      );
    }, [sessionId])
  );

  if (status === 'streaming') {
    return <span className="bg-green-500 h-2 w-2 rounded-full animate-pulse" />;
  }
  if (status === 'error') {
    return <span className="bg-destructive h-2 w-2 rounded-full" />;
  }
  if (isWaitingForUser) {
    return <span className="bg-amber-500 h-2 w-2 rounded-full animate-pulse" />;
  }
  if (hasUnseenActivity) {
    return <span className="bg-blue-500 h-1.5 w-1.5 rounded-full" />;
  }
  return null;
}
```

Integrated into `SessionItem` next to the title, only for non-active sessions (the active session's status is visible in the chat panel).

### Data Ownership After Refactor

| Data                               | Owner                             | Rationale                        |
| ---------------------------------- | --------------------------------- | -------------------------------- |
| Streaming messages, parts, deltas  | Session Chat Store (Zustand)      | Survives component lifecycle     |
| Input drafts                       | Session Chat Store                | Preserved per session            |
| Streaming status, errors           | Session Chat Store                | Readable by sidebar              |
| Server-confirmed history           | TanStack Query cache              | Authoritative server state       |
| Active session ID                  | TanStack Router URL param         | Navigation source of truth       |
| UI-only flags (sidebar open, etc.) | useAppStore (Zustand)             | Global, session-independent      |
| isStreaming/isTextStreaming bridge | useAppStore via useChatStatusSync | Backward compat for global flags |

### Stream Event Handler Refactor

`stream-event-handler.ts` changes from receiving React `setState` callbacks to calling store actions:

**Before:**

```typescript
deps.setMessages((prev) => [...prev, newMessage]);
deps.setStatus('streaming');
```

**After:**

```typescript
const store = useSessionChatStore.getState();
const session = store.getSession(sessionId);
store.updateSession(sessionId, {
  messages: [...session.messages, newMessage],
});
// status is already set by StreamManager.start()
```

The `StreamEventDeps` interface is replaced by a simpler `StreamDispatchContext`:

```typescript
interface StreamDispatchContext {
  sessionId: string;
  store: typeof useSessionChatStore;
  onTaskEvent?: (event: TaskUpdateEvent) => void;
  onSessionIdChange?: (newId: string) => void;
  onStreamingDone?: () => void;
}
```

## User Experience

### Switching Sessions

**Before:** Switching sessions clears input, shows loading spinner while history reloads, loses streaming state.

**After:** Switching sessions is instant. Input draft is restored. Messages are already in the store. If the session was streaming in the background, the streaming animation resumes exactly where it was.

### Multiple Concurrent Agents

Users running 3-5 agents simultaneously see:

- Active session: full chat panel with streaming
- Background sessions: green pulse dot in sidebar while streaming
- When a background agent finishes: blue dot indicating new activity
- When a background agent hits an error: red dot
- When a background agent needs tool approval: amber pulse dot

### Session Remap

**Before:** Brief empty flash when sessionId changes from client UUID to server UUID.

**After:** Zero flash. `renameSession` swaps the store key atomically before React re-renders.

## Testing Strategy

### Unit Tests — Session Chat Store

```typescript
describe('useSessionChatStore', () => {
  beforeEach(() => useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] }));

  it('initializes session with default state', () => {
    /* ... */
  });
  it('updates session fields via updateSession', () => {
    /* ... */
  });
  it('renames session atomically preserving all state', () => {
    /* ... */
  });
  it('evicts oldest idle sessions beyond MAX_RETAINED_SESSIONS', () => {
    /* ... */
  });
  it('never evicts sessions with status === streaming', () => {
    /* ... */
  });
  it('tracks access order for LRU eviction', () => {
    /* ... */
  });
  it('destroySession removes session and access order entry', () => {
    /* ... */
  });
  it('getSession returns default state for unknown sessionId', () => {
    /* ... */
  });
});
```

### Unit Tests — StreamManager

```typescript
describe('StreamManager', () => {
  let manager: StreamManager;
  let mockTransport: MockTransport;

  beforeEach(() => {
    manager = new StreamManager(); // Fresh instance per test
    mockTransport = createMockTransport();
  });

  it('starts a stream and dispatches events to store', async () => {
    /* ... */
  });
  it('aborts a specific session stream', () => {
    /* ... */
  });
  it('starting a new stream for the same session aborts the previous one', () => {
    /* ... */
  });
  it('concurrent streams for different sessions do not interfere', async () => {
    /* ... */
  });
  it('handles session remap in done event', async () => {
    /* ... */
  });
  it('sets hasUnseenActivity for background sessions on done', async () => {
    /* ... */
  });
  it('retries transient errors before surfacing to user', async () => {
    /* ... */
  });
  it('restores input on SESSION_LOCKED error', async () => {
    /* ... */
  });
  it('cleans up timers on abort', () => {
    /* ... */
  });
  it('abortAll stops all active streams', () => {
    /* ... */
  });
});
```

### Acceptance Test (write before Phase 2)

```typescript
describe('Multi-session streaming', () => {
  it('switching sessions while streaming does NOT abort background stream', async () => {
    // 1. Start streaming in session A
    // 2. Switch to session B (change sessionId)
    // 3. Verify session A's stream is still active (not aborted)
    // 4. Verify session B shows clean state
    // 5. Switch back to session A
    // 6. Verify accumulated messages are present
  });
});
```

### Integration Tests

- `useChatSession` hook tests updated to mock `useSessionChatStore` instead of inspecting `useState`
- `ChatPanel` tests remain unchanged (mock transport pattern still works)
- Selector hook tests verify re-render isolation (session B update doesn't trigger session A re-render)

### E2E Tests (Playwright)

- Open two sessions, start streaming in both, verify sidebar shows two green dots
- Switch between sessions during streaming, verify messages accumulate correctly
- Verify input draft persists across session switches
- Verify background session error badge appears and clears on navigation

## Performance Considerations

1. **Store size**: MAX_RETAINED_SESSIONS = 20, ~50 messages per session at ~1KB each = ~1MB at peak. Acceptable for a developer tool.

2. **Re-render isolation**: Session-scoped selectors with `useCallback` ensure session B updates cause zero re-renders in components displaying session A. The `useSessionStatus(sessionId)` selector for sidebar badges returns a primitive — no unnecessary re-renders.

3. **immer performance**: `immer` middleware patches the messages array. At streaming rates (~20 events/sec), this is O(N) where N = message count. For sessions with <1000 messages, this is negligible. If benchmarking reveals issues in Phase 4, replace `immer` with manual spread for the `messages` update path only.

4. **devtools cost**: The `devtools` middleware serializes the entire store on every update. With concurrent streaming at 20 events/sec, this is expensive. Only enable in dev (`import.meta.env.DEV`).

5. **Selector stability**: `useCallback` memoizes selectors per `sessionId`. When `sessionId` changes (session switch), a new selector is created — this is correct and intentional. The old selector is garbage collected.

6. **TanStack Query + Zustand duplication**: History exists in both TanStack Query cache and Zustand store. This is intentional — TanStack Query is the source of truth for server-confirmed history; Zustand owns the enriched display state (streaming deltas, client-only flags, error states).

## Security Considerations

1. **No `persist` middleware**: Message content must not be written to localStorage. The session chat store is in-memory only.

2. **StreamManager session isolation**: `abort(sessionId)` is a no-op if the sessionId has no active stream. No cross-session interference is possible.

3. **Transport auth unchanged**: StreamManager calls `transport.sendMessage()` which already handles `X-Client-Id` headers and session locking. No new auth surface.

4. **`selectedCwd` as parameter**: Passed to `streamManager.start()` at call time, not stored globally. Prevents stale CWD from being used in delayed stream starts.

## Implementation Phases

### Phase 1+2: Infrastructure + AbortController Migration

**Ship as one PR.** Zero user-visible behavior change except: stopping works correctly across sessions.

New files:

- `apps/client/src/layers/entities/session/model/session-chat-store.ts`
- `apps/client/src/layers/entities/session/model/__tests__/session-chat-store.test.ts`
- `apps/client/src/layers/features/chat/model/stream-manager.ts`
- `apps/client/src/layers/features/chat/model/__tests__/stream-manager.test.ts`

Modified files:

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — `handleSubmit` delegates to `streamManager.start()`, `stop` delegates to `streamManager.abort()`. AbortRef removed.
- `apps/client/src/layers/entities/session/index.ts` — Export store and selector hooks.

Acceptance test: multi-session streaming (switching sessions doesn't abort background stream).

### Phase 3: State Field Migration + Background Indicators

**Standalone PR.** User-visible: background activity indicators appear in sidebar; input drafts preserved.

Modified files:

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Replace 15 `useState` calls with store reads. Remove tactical `useEffect` session-switch reset.
- `apps/client/src/layers/features/session-list/ui/SessionItem.tsx` — Add `SessionActivityIndicator` component.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — setState calls → store.updateSession() calls.
- `apps/client/src/layers/features/chat/model/stream-event-types.ts` — `StreamEventDeps` → `StreamDispatchContext`.

Field migration order (each independently testable):

1. `status` → enables background indicators
2. `error`, `sessionBusy`
3. `input` → enables draft preservation
4. `sessionStatus`, `presenceInfo`, `presencePulse`
5. `streamStartTime`, `estimatedTokens`, `isTextStreaming`
6. `isRateLimited`, `rateLimitRetryAfter`
7. `systemStatus`, `promptSuggestions`

### Phase 4: Messages Migration + Remap

**Standalone PR.** Highest risk. User-visible: instant session switch (no loading flash), remap has no empty flash.

Modified files:

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Messages read from store. History seeding effect writes to store. `historySeededRef` → store field.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Message mutations write to store.
- `apps/client/src/layers/features/chat/model/stream-event-helpers.ts` — May need store access for `deriveFromParts`.

`renameSession` implementation and `isRemappingRef` removal happen here.

### Phase 5: Cleanup

**Standalone PR.** Zero behavior change. Code health only.

- Remove dead `useState`/`useRef` declarations from `useChatSession`
- Remove unused imports
- Verify `useChatSession` is ~300 lines
- Update barrel exports
- Run full test suite (3370+ tests)
- Update `useChatStatusSync` if needed

## Open Questions

All questions were resolved during ideation. No open questions remain.

## Related ADRs

- **ADR-0005**: Zustand for UI state, TanStack Query for server state — session chat store is UI state
- **ADR-0179**: Centralized AdapterStreamManager — directly analogous pattern for StreamManager
- **ADR-0104**: Client-side message queue with auto-flush — related session-scoped state pattern
- **ADR-0145**: Streaming message tag for client ID dedup — `_streaming` flag preserved in store
- **ADR-0146**: Skip post-stream replace for message stability — reconciliation pattern preserved

## References

- `specs/session-state-manager/01-ideation.md` — Ideation document with full research
- `research/20260328_session_state_manager_architecture.md` — Architecture design with code examples
- `research/20260328_session_state_manager_library_evaluation.md` — Library evaluation
- `research/20260307_relay_streaming_bugs_tanstack_query.md` — Prior validation of Zustand streaming state
- `research/20260327_sse_singleton_strictmode_hmr.md` — Module-level singleton pattern
- `research/20260312_fix_chat_stream_remap_bugs.md` — Remap timing analysis
- [Zustand and React Context — TkDodo](https://tkdodo.eu/blog/zustand-and-react-context)
- [Zustand Selectors & Re-rendering — DeepWiki](https://deepwiki.com/pmndrs/zustand/2.3-selectors-and-re-rendering)

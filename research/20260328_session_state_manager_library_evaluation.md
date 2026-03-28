---
title: 'Session State Manager Library Evaluation — TanStack Store, DB, Pacer, Jotai, Valtio, Legend State, XState, RxJS'
date: 2026-03-28
type: external-best-practices
status: active
tags:
  [
    session-state,
    tanstack-store,
    tanstack-db,
    tanstack-pacer,
    jotai,
    valtio,
    legend-state,
    xstate,
    zustand,
    react-19,
    streaming,
    sse,
    concurrent-sessions,
    state-management,
  ]
feature_slug: session-state-manager
searches_performed: 18
sources_count: 35
---

# Session State Manager Library Evaluation

## Research Summary

The goal is to decouple per-session chat state (messages, input, streaming status, errors) from React component lifecycle into an external store keyed by `sessionId`, supporting multiple concurrent streaming sessions with instant session switching. After evaluating TanStack Store, TanStack DB, TanStack Pacer, Jotai (jotai-family), Valtio, Legend State, XState, and RxJS against this requirement, the clearest answer is: **Zustand with a `Map<sessionId, StoreApi<SessionState>>` pattern (the Dominik/TkDodo pattern) is the strongest fit for this codebase**. It is zero-new-dependency, matches the existing stack, and solves the problem precisely. The only library worth adding is **TanStack Pacer** for the debouncer/throttler utilities — it directly replaces the scattered `setTimeout` timers with composable, React-aware abstractions.

---

## Key Findings

### 1. TanStack Store — Skip It (for now)

TanStack Store (`@tanstack/store`, `@tanstack/react-store`) is the signals-based state primitive used internally by TanStack Query, Router, and Table. It is available as a standalone library.

**What it is:** An immutable-reactive store using a subscriber model. You create a `Store<T>` instance, read with `.state`, write with `.setState(updater)`, and subscribe in React via `useStore(store, selector?)`.

**How it compares to Zustand:**

| Dimension             | TanStack Store                                                      | Zustand                                        |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| API style             | `new Store(initial)` + `useStore(store, sel)`                       | `create<T>()(set => ...)` + auto-bound hook    |
| Mutations             | `store.setState(prev => ({...prev, x: y}))`                         | `set(state => ({x: y}))` or `setState({x: y})` |
| Devtools              | None currently (community-requested feature)                        | Zustand devtools middleware (mature)           |
| Persistence           | None (community-requested)                                          | `persist` middleware (built-in)                |
| Bundle size (core)    | ~1.4 kB gzip                                                        | ~1.1 kB gzip                                   |
| React adapter size    | ~0.6 kB gzip (incremental over core)                                | Included in the above                          |
| Version               | v0.7.x (alpha by TanStack's own classification)                     | v5.x (stable, 5+ years)                        |
| Weekly downloads      | ~1.1M (largely driven by TanStack Router/Query using it internally) | ~12M+                                          |
| Application community | Thin — designed first as a library primitive                        | Very large, well-documented patterns           |

**Does it support keyed/Map state?** Yes, trivially — any `Store<Map<string, SessionState>>` or `Store<Record<string, SessionState>>` works. But there is nothing special about TanStack Store that makes this easier than Zustand. You'd write the same shape of code.

**React integration quality:** `useStore(store, selector)` is clean and type-safe. The selector is a subscribe-to-subset-of-state function, similar to Zustand's `useShallow`. It uses `useSyncExternalStore` under the hood.

**Would it replace Zustand?** The TanStack maintainer discussions confirm that using Zustand alongside TanStack Query/Router is the dominant pattern in the ecosystem and that TanStack Store lacks application-facing DX features (devtools, persistence, action history) that Zustand provides. The GitHub discussion (#143 in TanStack/store) shows the library is still debating whether it wants to be a full application state manager or remain an internal primitive.

**Verdict: Skip It.** TanStack Store offers no concrete benefit over Zustand for this use case, has thinner tooling, and is still alpha. The ~0.3 kB size advantage is negligible. If you already use Zustand, there is no reason to introduce a second Zustand-equivalent.

---

### 2. TanStack DB — Skip It (not the right tool)

TanStack DB (`@tanstack/db`) is an embedded client-side database powered by differential dataflow. It is currently at v0.1 (first beta, announced with "migration office hours for first 20 teams").

**What it actually does:**

- Maintains normalized, typed **Collections** (think client-side tables) in memory
- Uses **d2ts** (differential dataflow in TypeScript) for live queries that update _incrementally_ — changing one row in a 100,000-item collection recomputes in ~0.7ms (M1 Pro benchmark)
- Provides transactional mutations with built-in optimistic rollback
- Plugs into existing TanStack Query `useQuery` calls via `QueryCollection`
- Also offers `LocalOnlyCollection` for in-memory state that doesn't sync to a backend

**Collection types:**

| Type                     | Use case                                            |
| ------------------------ | --------------------------------------------------- |
| `QueryCollection`        | REST/GraphQL/tRPC — wraps a `useQuery` queryFn      |
| `ElectricCollection`     | Postgres real-time sync via ElectricSQL             |
| `LocalOnlyCollection`    | In-memory, local-only, no server sync               |
| `LocalStorageCollection` | Persists to localStorage, syncs across browser tabs |

**Would it help with session-keyed state?** Technically, you could model each session as a row in a `LocalOnlyCollection` and use a live query filtered to `sessionId`. The Immer-style draft mutation API is ergonomic. But the overhead is substantial: you'd be running differential dataflow (a full incremental computation engine) on top of a handful of in-memory session objects. That is engineering-for-future-scale at the cost of present complexity.

**Is it production-ready?** No. The official release announcement (March 2026) explicitly positions this as "first beta" and offers migration support only for the first 20 early adopters. The library is solving a harder problem (relational reactive sync) than session state management requires.

**The actual use case for TanStack DB in DorkOS:** If you ever need to join data across agents, sessions, and relay messages reactively in the client (e.g., "show all messages across sessions from agent X that contain error events"), TanStack DB's differential dataflow could become very powerful. But that is a future capability, not a present need.

**Verdict: Skip It (now). Watch It (6 months).** Wrong layer for session-keyed state. Overkill and not yet stable. Revisit when it reaches v1.0.

---

### 3. TanStack Pacer — Use It (selectively)

TanStack Pacer (`@tanstack/pacer`, `@tanstack/react-pacer`) is a standalone timing/scheduling library. It is at v0.20.0 (March 2026), 691 GitHub stars, actively maintained. Not to be confused with TanStack's other libraries — this one is not part of the Router/Query ecosystem; it is a focused utility library.

**What it provides:**

| Utility    | What it does                                           | Class API     | React hook                                  |
| ---------- | ------------------------------------------------------ | ------------- | ------------------------------------------- |
| Debounce   | Delay execution until inactivity period expires        | `Debouncer`   | `useDebouncer`, `useDebouncedCallback`      |
| Throttle   | Execute at most once per time interval                 | `Throttler`   | `useThrottledCallback`, `useThrottledValue` |
| Rate Limit | Restrict execution frequency (fixed or sliding window) | `RateLimiter` | `useRateLimitedCallback`                    |
| Queue      | Process calls sequentially (FIFO, LIFO, Priority)      | `Queuer`      | `useQueuedState`                            |
| Batch      | Group multiple calls into single executions            | `Batcher`     | `useBatchedCallback`                        |

All utilities have both sync and async variants with promise support and error propagation.

**Relevance to DorkOS streaming:**

The current codebase has several `setTimeout`-based timers per session (streaming timeout, SSE reconnection delay, indicator animation timer, history refresh debounce — 4+ per session). These are:

- Scattered across `useEffect` hooks
- Not composable or testable in isolation
- Cancelled with `clearTimeout` ref tracking (fragile across hot reload)

TanStack Pacer provides React-lifecycle-aware replacements:

1. **Streaming text event debouncer**: Instead of batching incoming `text_delta` SSE events manually with a `setTimeout`, use `useDebouncedCallback` with a 16ms wait to coalesce rapid micro-updates before committing to state.

2. **SSE reconnection throttler**: Currently implemented with manual `setTimeout` + ref guards. Replace with `useThrottledCallback` with a leading+trailing edge throttle on the reconnect logic.

3. **Input debounce**: Any debounced search/autocomplete in the session input can use `useDebouncedCallback`.

4. **Async queue for sequential tool result processing**: When multiple tool results arrive concurrently, a `Queuer` with concurrency=1 enforces ordering without ad-hoc mutex patterns.

**Is it production-ready?** v0.20.0 with 146 releases suggests active iteration. It is not v1.0 but the API is stable and the utilities are simple enough that the risk is low. Tree-shakeable, so you only pay for what you import. Bundle size impact is minimal (each utility is a few hundred bytes gzipped).

**Incremental adoption:** Each utility can be adopted independently, one hook at a time. No architecture changes required.

**Verdict: Use It (selectively).** Start with `useDebouncedCallback` for SSE event batching and `useThrottledCallback` for SSE reconnection. Do not introduce Pacer just to replace a single `setTimeout` — adopt it where you have 2+ timers of the same type.

---

### 4. Jotai (jotai-family) — Watch It

Jotai is an atomic, bottom-up state management library from the Poimandres collective (same team as Zustand and Valtio). The `atomFamily` pattern (now in the standalone `jotai-family` package) provides exactly what the session state use case needs: **a factory that creates one atom per `sessionId`, lazily on first access, with built-in eviction support**.

**The `atomFamily` pattern:**

```typescript
import { atomFamily } from 'jotai-family';

const sessionStateAtom = atomFamily((sessionId: string) =>
  atom<SessionState>({
    messages: [],
    input: '',
    status: 'idle',
    error: null,
  })
);

// In a component:
const [state, setState] = useAtom(sessionStateAtom(sessionId));
```

**Keyed state:** `atomFamily` internally uses a `Map<param, atom>`. Atoms are created lazily. You can evict them:

```typescript
sessionStateAtom.setShouldRemove((createdAt, param) => {
  // Evict sessions not accessed in 30 minutes
  return Date.now() - createdAt > 30 * 60 * 1000;
});
```

**Derived state:** Jotai's greatest strength is derived/computed atoms. You can define a `readOnlyAtom` that computes `activeInteraction` from `messagesAtom(sessionId)`:

```typescript
const activeInteractionAtom = atomFamily((sessionId: string) =>
  atom((get) => computeActiveInteraction(get(sessionStateAtom(sessionId))))
);
```

**React 19 / Compiler compatibility:** The `observer` pattern is broken with React Compiler. The recommended migration is to use `useValue` / `useAtomValue` hooks instead of auto-tracking. This is documented and the team is actively maintaining compatibility.

**Why not adopt it now:**

- DorkOS already has Zustand for global UI state. Introducing a second state primitive (atoms alongside stores) adds cognitive overhead and two mental models.
- The `jotai-family` package is a separate package with its own maturity curve.
- The derived state advantage (computing `activeInteraction` from messages) can also be expressed with Zustand selectors or plain memoization — it requires Jotai's full model only if derived state becomes deeply layered.
- Jotai's atomic model is architecturally different from Zustand's centralized store — mixing them creates an impedance mismatch in debugging.

**Verdict: Watch It.** If the session state manager grows to require complex derived state with many layers of computed values (e.g., `activeInteraction` → `isBlockedByTool` → `canSendMessage` → ...), Jotai's atomic composition becomes worth the model switch. Not today.

---

### 5. Valtio — Skip It

Valtio uses `Proxy` to create mutable reactive state. You mutate directly: `state.messages.push(msg)` instead of `set(s => ({messages: [...s.messages, msg]}))`.

**The proxyMap utility** (`import { proxyMap } from 'valtio/utils'`) creates a Map-like proxy with `set`, `get`, `delete`, and `forEach`, which would work for session-keyed state.

**React 19 / Concurrent mode:** Valtio intentionally separates write and read proxies for concurrent React compatibility. The `useSnapshot` hook uses `useSyncExternalStore` internally.

**Why not adopt it:**

- The mutable API (`state.x = y`) is the opposite philosophy of the existing DorkOS codebase, which uses immutable Zustand patterns.
- Valtio's proxy-based tracking can be surprising with complex nested objects (proxy transparency issues with `instanceof`, `JSON.stringify`, etc.).
- Adding mutable proxy state alongside immutable Zustand creates a mixed mental model with no benefit — you'd be using two different state paradigms for different parts of the same feature.
- The main Valtio advantage (reduced boilerplate via mutation) is not compelling when the existing patterns are already established and clean.

**Verdict: Skip It.** The mutation model conflicts with existing code conventions.

---

### 6. Legend State v3 — Skip It (interesting but wrong layer)

Legend State is a signals/observables library with a 4kb bundle. Its signature feature is that primitives (observables) can be read directly inside JSX without hooks, achieving "fine-grained reactivity" where individual DOM nodes re-render without component re-renders.

**React 19 / Compiler issue:** The `observer` wrapper (Legend State's primary React integration) is **broken with React Compiler** because it depends on `state$.get()` returning different values across renders — which Compiler's memoization breaks. The documented migration is to replace `observer` + auto-tracking with explicit `useValue(state$.field)` hooks. This is a meaningful API regression relative to the library's core selling point.

**Bundle size:** 4kb gzip for the core — competitive.

**Why not adopt it:**

- The React Compiler incompatibility of the `observer` pattern matters because DorkOS is built with React 19 and the React Compiler is shipping as stable (v1.0 announced in October 2025).
- Legend State's fine-grained DOM-level reactivity is optimized for cases with thousands of frequently-updated nodes (e.g., a spreadsheet, a large table). A chat message list with TanStack Virtual already handles this efficiently at the component level.
- Introduces a third state primitive (observables) alongside Zustand stores and TanStack Query cache.

**Verdict: Skip It.** Interesting technology but React Compiler compat issues and the wrong optimization target for a chat interface.

---

### 7. XState v5 — Watch It (not for state storage, but for streaming lifecycle)

XState v5 models state as **actors** communicating via message passing. A streaming chat session has a textbook state machine lifecycle:

```
idle → sending → streaming → (done | error | timeout) → idle
```

Within `streaming`, there are sub-states:

- `waiting_for_first_token`
- `streaming_text`
- `streaming_tool_call`
- `tool_call_awaiting_approval`

**Where XState excels:** Encoding this lifecycle explicitly eliminates an entire class of bugs from `if (isStreaming && !isError && status !== 'idle')` boolean soup. The streaming lifecycle in `use-chat-session.ts` is currently represented by a `status: 'idle' | 'streaming' | 'error'` string plus 4+ boolean-equivalent refs — a classic implicit state machine.

**Practical tradeoffs for DorkOS:**

| Dimension                   | XState for streaming lifecycle                                 |
| --------------------------- | -------------------------------------------------------------- |
| Conceptual clarity          | High — explicit transitions, impossible states encoded by type |
| Boilerplate                 | High — machine definition is verbose                           |
| Bundle size (xstate core)   | ~19kb gzip (significant addition)                              |
| Bundle size (@xstate/react) | ~3kb gzip (on top of core)                                     |
| Devtools                    | Stately Studio (excellent visual debugger)                     |
| Team familiarity            | Requires learning investment                                   |
| React 19 compatibility      | Full — `useMachine`, `useSelector` hooks are stable            |
| Incremental adoption        | Possible — one machine per session, isolated                   |

**The real question:** Is the complexity of the streaming lifecycle high enough to justify a state machine? Currently `use-chat-session.ts` is ~437 lines with refs tracking streaming state. If that complexity grows to 600+ lines with `streaming_tool_call_approval` flows, XState starts paying for itself.

**Verdict: Watch It.** Not for session state storage, but as a future investment for the streaming lifecycle machine. If `use-chat-session.ts` grows to model tool approval flows, XState becomes the principled approach. At ~19kb gzip for the core, the cost is real.

---

### 8. The Recommended Architecture: Zustand External Store Map

The best answer requires zero new dependencies. Dominik (TkDodo, TanStack Query maintainer) documented this pattern explicitly:

**Pattern: `Map<sessionId, StoreApi<SessionState>>` with `createStore()`**

```typescript
import { createStore, useStore } from 'zustand';

interface SessionState {
  messages: ChatMessage[];
  streamingText: string;
  status: 'idle' | 'streaming' | 'error';
  error: string | null;
  input: string;
  activeInteraction: ActiveInteraction | null;
}

type SessionActions = {
  appendMessage: (msg: ChatMessage) => void;
  appendStreamChunk: (text: string) => void;
  setStatus: (status: SessionState['status']) => void;
  setInput: (input: string) => void;
  reset: () => void;
};

// Module-level Map — lives outside React, persists across route changes
const sessionStores = new Map<string, StoreApi<SessionState & SessionActions>>();

function getOrCreateSessionStore(sessionId: string) {
  if (!sessionStores.has(sessionId)) {
    sessionStores.set(
      sessionId,
      createStore<SessionState & SessionActions>((set) => ({
        messages: [],
        streamingText: '',
        status: 'idle',
        error: null,
        input: '',
        activeInteraction: null,
        appendMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
        appendStreamChunk: (text) => set((s) => ({ streamingText: s.streamingText + text })),
        setStatus: (status) => set({ status }),
        setInput: (input) => set({ input }),
        reset: () => set({ messages: [], streamingText: '', status: 'idle', error: null }),
      }))
    );
  }
  return sessionStores.get(sessionId)!;
}

// Hook — components subscribe to only the slice they need
function useSessionState<T>(
  sessionId: string,
  selector: (state: SessionState & SessionActions) => T
): T {
  const store = getOrCreateSessionStore(sessionId);
  return useStore(store, selector);
}

// Eviction — call when closing a session permanently
function evictSessionStore(sessionId: string) {
  sessionStores.delete(sessionId);
}
```

**Why this is the right answer:**

1. **Zero new dependencies** — uses `createStore` from the already-installed Zustand v5.
2. **External to React lifecycle** — the Map lives at module scope. Switching routes, unmounting components, and remounting doesn't destroy state.
3. **Instant session switching** — switching `sessionId` triggers a new `getOrCreateSessionStore` call which is a Map lookup (`O(1)`). State is immediately available.
4. **Concurrent streaming** — each session has its own store. Multiple sessions can stream independently with no shared state contention.
5. **Granular subscriptions** — `selector` ensures a component subscribed to `streamingText` doesn't re-render when `status` changes.
6. **SSE event handlers can write directly** — the `streamEventHandler` (which currently lives outside React) can call `getOrCreateSessionStore(sessionId).setState(...)` without any React coupling.
7. **Lazy creation** — stores are created on first access, so sessions not yet opened have zero memory cost.
8. **Controllable eviction** — call `evictSessionStore(sessionId)` when a session is permanently closed. For a tool that handles 10-20 sessions per week, this is trivially managed.

**This pattern directly solves the core problem in `use-chat-session.ts`:** The race conditions between local streaming state and TanStack Query's history cache (documented in `research/20260307_relay_streaming_bugs_tanstack_query.md`) arise because streaming state lives in React component state that is coupled to component lifecycle. Moving streaming state to an external store breaks this coupling entirely. TanStack Query reverts to its proper role: fetching and caching server-confirmed history snapshots.

---

## Decision Matrix

| Library                      | Fit for session-keyed state    | Incremental adoption       | Bundle size impact | Maturity      | Verdict                  |
| ---------------------------- | ------------------------------ | -------------------------- | ------------------ | ------------- | ------------------------ |
| Zustand (external store Map) | Excellent                      | Zero-dependency            | 0 kB additional    | Stable        | **Use It**               |
| TanStack Pacer               | Good (timer replacement)       | Per-utility, low-risk      | ~1–2 kB gzip       | v0.20, active | **Use It (selectively)** |
| Jotai atomFamily             | Good (derived state)           | Requires model shift       | ~3 kB gzip         | Stable        | Watch It                 |
| XState v5                    | Good (streaming lifecycle)     | Medium — one machine       | ~22 kB gzip        | Stable        | Watch It                 |
| TanStack Store               | Neutral (same as Zustand)      | Easy but redundant         | ~2 kB gzip         | Alpha         | Skip It                  |
| TanStack DB                  | Poor (wrong abstraction layer) | N/A — beta                 | Unknown, large     | Beta          | Skip It (watch in 6mo)   |
| Valtio                       | Neutral (proxyMap works)       | Conflicts with conventions | ~3 kB gzip         | Stable        | Skip It                  |
| Legend State v3              | Neutral (observables)          | Medium                     | ~4 kB gzip         | Beta          | Skip It                  |

---

## Detailed Analysis

### Why the Current Architecture Creates the Bugs

The root cause documented in prior research (`20260307_relay_streaming_bugs_tanstack_query.md`) is architectural: streaming state (`messages`, `streamingText`, `status`) lives in React component state (`useState`, `useRef`) inside `use-chat-session.ts`. This creates three problems:

1. **Lifecycle coupling**: When the `SessionPage` unmounts and remounts (route change), all streaming state is destroyed and re-initialized from the TanStack Query cache. This is the source of the history seed/duplication race.

2. **Closure staleness**: SSE event handlers (e.g., the `sync_update` listener) close over `status` and `isStreaming` at effect creation time. State captured in closures is stale unless tracked via refs — which is why the file accumulates `isStreamingRef`, `statusRef`, `selectedCwdRef`, and `messagesRef`.

3. **Concurrent streaming limitation**: If two sessions are streaming simultaneously, each is isolated in its own component instance. But switching between them unmounts/remounts the active component, destroying one stream's in-progress state.

Moving to an external store removes all three problems in one architectural decision.

### The Correct Division of State After Refactor

After adopting the external Zustand store Map:

| State type                         | Where it lives                          | Why                                                   |
| ---------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| In-flight streaming text           | `sessionStores.get(id).streamingText`   | Must survive component unmount                        |
| Streaming status                   | `sessionStores.get(id).status`          | Must be readable by SSE handler outside React         |
| Messages (local, pre-confirm)      | `sessionStores.get(id).messages`        | Must survive tab switch                               |
| Input text                         | `sessionStores.get(id).input`           | Nice to preserve across tab switch                    |
| Server-confirmed history           | TanStack Query cache                    | Server state, fetch-on-demand, stale-while-revalidate |
| Active session ID                  | TanStack Router URL param (`?session=`) | Source of truth for navigation                        |
| UI-only state (sidebar open, etc.) | Existing Zustand global store           | Short-lived UI state, component-level                 |

### Where TanStack Pacer Fits

The `use-chat-session.ts` file currently uses `setTimeout` in at least these places:

- SSE reconnection delay (exponential backoff)
- Streaming timeout detection
- Post-stream history refresh debounce
- Status indicator animation timer (if applicable)

TanStack Pacer replacements:

```typescript
import { useThrottledCallback } from '@tanstack/react-pacer';

// SSE reconnection — throttle to max once per 2s (with exponential backoff on top)
const reconnect = useThrottledCallback(() => initSSEConnection(sessionId), {
  wait: 2000,
  leading: false,
  trailing: true,
});

// Streaming text commit — debounce rapid text_delta events into 16ms batches
import { useDebouncedCallback } from '@tanstack/react-pacer';
const commitStreamChunk = useDebouncedCallback((text: string) => store.appendStreamChunk(text), {
  wait: 16,
});
```

The key advantage: Pacer hooks respect React lifecycle (the debounced/throttled function is stable across renders) and flush on unmount, preventing leaked timers.

---

## Sources & Evidence

- TanStack Store overview — [Overview | TanStack Store Docs](https://tanstack.com/store/latest/docs/overview)
- TanStack Store React adapter — [React | TanStack Store React Docs](https://tanstack.com/store/latest/docs/framework/react/reference/functions/usestore)
- TanStack Store GitHub — [TanStack/store: Framework agnostic, type-safe store](https://github.com/TanStack/store)
- TanStack Store applications discussion — [TanStack Store for Applications](https://github.com/TanStack/store/discussions/143)
- TanStack Store installation — [Installation | TanStack Store Docs](https://tanstack.com/store/latest/docs/installation)
- TanStack DB blog announcement — [Stop Re-Rendering: TanStack DB 0.1](https://tanstack.com/blog/tanstack-db-0.1-the-embedded-client-database-for-tanstack-query)
- TanStack DB overview — [Overview | TanStack DB Docs](https://tanstack.com/db/latest/docs/overview)
- TanStack DB deep dive — [How to use TanStack DB to build reactive apps — LogRocket](https://blog.logrocket.com/tanstack-db-ux/)
- TanStack DB interactive guide — [An Interactive Guide to TanStack DB — Frontend at Scale](https://frontendatscale.com/blog/tanstack-db/)
- TanStack DB LocalOnly collection — [LocalOnly Collection | TanStack DB Docs](https://tanstack.com/db/latest/docs/collections/local-only-collection)
- TanStack Pacer GitHub — [TanStack/pacer](https://github.com/TanStack/pacer)
- TanStack Pacer npm package — [@tanstack/react-pacer](https://www.npmjs.com/package/@tanstack/react-pacer)
- TanStack Pacer which utility guide — [Which Pacer Utility Should I Choose?](https://tanstack.dev/pacer/latest/docs/guides/which-pacer-utility-should-i-choose)
- TanStack Pacer debouncing guide — [Debouncing Guide | TanStack Pacer Docs](https://tanstack.com/pacer/latest/docs/guides/debouncing)
- Pacer useDebouncedCallback reference — [useDebouncedCallback | TanStack Pacer React Docs](https://tanstack.com/pacer/latest/docs/framework/react/reference/functions/useDebouncedCallback)
- TanStack ecosystem guide 2026 — [TanStack in 2026: Developer's Decision Guide — CodeWithSeb](https://www.codewithseb.com/blog/tanstack-ecosystem-complete-guide-2026)
- Zustand + React Context / external store pattern — [Zustand and React Context — TkDodo](https://tkdodo.eu/blog/zustand-and-react-context)
- Zustand createStore vanilla — [useStore — Zustand docs](https://zustand.docs.pmnd.rs/hooks/use-store)
- Jotai atomFamily docs — [Family — Jotai docs](https://jotai.org/docs/utilities/family)
- Jotai jotai-family package — [GitHub: pmndrs/jotai](https://github.com/pmndrs/jotai)
- Legend State v3 React API — [React API — Legend State v3](https://legendapp.com/open-source/state/v3/react/react-api/)
- Legend State v3 React 19 compatibility — [Fine Grained Reactivity — Legend State v3](https://legendapp.com/open-source/state/v3/react/fine-grained-reactivity/)
- Legend State v3 migrating — [Migrating — Legend State v3](https://legendapp.com/open-source/state/v3/other/migrating/)
- XState v5 is here — [XState v5 — Stately](https://stately.ai/blog/2023-12-01-xstate-v5)
- XState actors — [Actors — Stately docs](https://stately.ai/docs/actors)
- XState npm — [xstate — npm](https://www.npmjs.com/package/xstate)
- Valtio proxyMap — [Getting Started — Valtio](https://valtio.dev/docs/introduction/getting-started)
- Valtio proxy docs — [proxy — Valtio docs](https://valtio.dev/docs/api/basic/proxy)
- State management 2025 comparison — [Zustand vs Jotai vs Valtio — reactlibraries.com](https://www.reactlibraries.com/blog/zustand-vs-jotai-vs-valtio-performance-guide-2025)
- Prior DorkOS research — [Relay-Mode SSE Streaming Bugs](../research/20260307_relay_streaming_bugs_tanstack_query.md)

---

## Research Gaps & Limitations

- Exact gzip sizes for `@tanstack/store` and `@tanstack/react-store` could not be retrieved from Bundlephobia (dynamic page). The ~1.4 kB estimate is based on secondary sources; verify at [bundlephobia.com/package/@tanstack/react-store](https://bundlephobia.com/package/@tanstack/react-store).
- TanStack DB bundle size is unconfirmed — the library is in beta and the docs do not publish size metrics.
- TanStack Pacer's full React hook catalog (complete list of `use*` exports) was partially retrieved. Consult the [Pacer React framework reference](https://tanstack.com/pacer/latest/docs/framework/react/reference/interfaces/reactqueuer) for the full list.
- XState v5 bundle size (~19kb gzip for core) is an approximation; `@xstate/react` is additional.
- The `jotai-family` package (vs deprecated core `atomFamily`) was not directly fetched — confirm the API is identical to the documented `atomFamily` before adopting.

## Contradictions & Disputes

- TanStack Store is described by some sources as "signal-based" and others as "immutable-reactive." The implementation is closer to immutable-reactive (setState takes an updater that returns a new object), but the subscription model is reactive/signal-like. This does not affect the practical comparison with Zustand.
- Legend State's React 19 compatibility story is somewhat unclear across sources. The official docs state `observer` is broken with React Compiler, but `useValue` is compatible. Whether "React 19 compatible" means the full API surface or just the recommended alternative APIs depends on how aggressively the codebase uses `observer`.

## Search Methodology

- Searches performed: 18
- Most productive search terms: "TanStack Store vs Zustand when to use 2025", "TanStack DB LocalOnlyCollection session state", "Zustand createStore external store Map keyed instances React 19", "TanStack Pacer React hooks useDebouncer SSE", "jotai atomFamily eviction memory management", "Legend State v3 React 19 compiler compatibility"
- Primary information sources: Official TanStack docs (store, db, pacer), TkDodo blog, GitHub discussions, npm package pages, LogRocket, LegendApp official docs, Stately/XState docs

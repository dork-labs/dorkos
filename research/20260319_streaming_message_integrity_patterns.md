---
title: 'Streaming Message Integrity: Optimistic Update, ID Reconciliation, and Event-Sourcing Patterns'
date: 2026-03-19
type: implementation
status: active
tags:
  [
    chat,
    streaming,
    optimistic-ui,
    tanstack-query,
    SSE,
    deduplication,
    event-sourcing,
    id-reconciliation,
    message-integrity,
  ]
feature_slug: streaming-message-integrity
searches_performed: 13
sources_count: 28
---

# Research Summary

This report covers four areas needed to inform the `streaming-message-integrity` spec's proposed
solution (skip the post-stream replace; use tagged-message dedup to reconcile client IDs with server
IDs when polling resumes). The key findings are:

1. **Production chat apps universally use a "nonce/temp-ID → server-ID remap" pattern**, not a
   post-stream replace. Slack uses `client_msg_id` (UUID) that persists as a secondary key alongside
   the authoritative server timestamp-ID. The proposed DorkOS approach is aligned with this industry
   standard.

2. **TanStack Query's canonical pattern for SSE + optimistic updates is `setQueryData` (not
   `invalidateQueries`) during streaming**, with cancellation of in-flight refetches at mutation
   start. The "skip the replace" strategy maps directly to TanStack Query's own guidance.

3. **Client-side event sourcing is an established real-world pattern** (used by Rapport with
   React/Redux/Elixir, and closely analogous to RTK Query's `onCacheEntryAdded` streaming API),
   but adds meaningful complexity. For the two bugs at hand, it is overkill — the tagged-dedup
   approach achieves the same correctness guarantee with far less structural change.

4. **Temporary-to-permanent ID reassignment is a well-solved problem.** The canonical pattern is
   keeping the temp ID as a secondary attribute (`temporaryId`/`client_msg_id`) and updating the
   primary ID in-place when the server confirms. Vercel AI SDK v5 does NOT solve this — the issue
   is an open known gap in their codebase too.

---

# Key Findings

## 1. Optimistic Update Patterns in Production Chat UIs

### Slack: `client_msg_id` as Secondary Deduplication Key

Slack's architecture separates message identity into two layers:

- **Client-generated UUID** (`client_msg_id`): created at send time, carried in the API request
  as a deduplication key. If the request is retried (network failure, reconnect), the server
  recognizes the same `client_msg_id` and suppresses duplicates.
- **Server-assigned timestamp ID** (`ts`): Slack's authoritative message identity uses a
  Unix timestamp with microsecond precision (e.g., `1512085950.000216`). This is what all other
  API calls reference.

The reconciliation flow:

```
User sends message
  → client creates temp bubble with client_msg_id UUID
  → API call: POST chat.postMessage { client_msg_id: "uuid-123", text: "..." }
  → server returns: { ok: true, ts: "1512085950.000216", channel: "C123" }
  → client finds the bubble by client_msg_id, updates its ts (primary ID)
  → future dedup (polling or WebSocket) uses ts; client_msg_id is retained for retry dedup
```

**Key insight:** Slack never replaces the entire message list. It finds the optimistic bubble by
`client_msg_id` and updates it in-place with the server-assigned `ts`. The optimistic bubble
transitions seamlessly to the server-confirmed message with no re-render flash.

### Vercel AI SDK `useChat`: The Same Problem, Unsolved

The Vercel AI SDK's `useChat` hook faces exactly the same dual-source problem as DorkOS.
Community discussions confirm:

- During streaming, each message part gets a dynamically changing `id` (the last streamed part's ID)
- After streaming, `onFinish` provides the "final" message with a consolidated ID
- `appendResponseMessages` and the hook's internal reconciliation use different ID logic, causing
  known mismatches
- The maintainers have not provided a canonical flash-prevention or dedup pattern

The gap DorkOS is solving is not unique — it is a known unresolved tension in the AI SDK ecosystem.
The Vercel SDK's official stance is to store `UIMessage` parts in JSONB and reconstruct on load,
avoiding the reconciliation problem entirely. This is only viable when the server stores everything
the client streamed — which DorkOS cannot do (errors, subagent parts, hook parts are not in JSONL).

### RTK Query's `onCacheEntryAdded`: The Streaming-First Pattern

RTK Query solves the dual-source problem structurally with `onCacheEntryAdded`:

```typescript
onCacheEntryAdded: async (arg, { updateCachedData, cacheDataLoaded, cacheEntryRemoved }) => {
  await cacheDataLoaded; // wait for initial history fetch
  const ws = new WebSocket(url);
  ws.onmessage = (event) => {
    updateCachedData((draft) => {
      // Immer-powered in-place patch — does NOT replace the whole list
      draft.messages.push(event.data);
    });
  };
  await cacheEntryRemoved;
  ws.close();
};
```

The pattern: **initial fetch populates the cache; streaming updates patch it in-place**. There is
no post-stream replace because the streaming handler IS the cache update mechanism. This is
architecturally equivalent to the proposed DorkOS solution's "skip the replace, let polling append."

**Pros:**

- Canonical pattern, actively maintained
- No ID mismatch (streaming updates patch the same cache entry that history populated)
- Works natively with `invalidateQueries` for refresh cycles

**Cons:**

- Requires restructuring so the SSE handler is the `queryFn`, not external React state
- DorkOS's streaming state is intentionally in local React state (not TanStack Query cache) for
  streaming performance reasons — moving it to the cache would be a large refactor

---

## 2. TanStack Query Optimistic Update + SSE Reconciliation

### The "Cancel-Snapshot-Optimistic-Invalidate" Pattern

TanStack Query's official optimistic update pattern has four steps:

1. **Cancel** all outgoing queries for that key (`cancelQueries`) — prevents in-flight fetches from
   overwriting optimistic state
2. **Snapshot** the current cache value (`getQueryData`) — for rollback on error
3. **Write optimistic state** (`setQueryData`) — displays immediately
4. **Invalidate on settle** (`invalidateQueries` in `onSettled`) — reconciles with server

The flash prevention mechanism is step 1 (cancel). Without it, an in-flight refetch completes
after the mutation starts and overwrites the optimistic state, causing a visible flash.

**DorkOS mapping:** The current code does step 4 without step 1. `invalidateQueries` fires after
streaming ends, which triggers a refetch of stale pre-stream history — causing the flash. The fix
in the spec (skip `invalidateQueries` after streaming) is essentially removing step 4 during the
streaming path and trusting the polling interval to handle eventual consistency.

### Preventing Over-Invalidation with Concurrent Mutations

TanStack Query expert Dominik Dorfmeister (tkdodo) identifies a common concurrent-mutation
flash cause:

> "When multiple mutations target the same data, earlier mutations should skip their invalidations.
> Since the settlement handler runs while the mutation is still active, checking for `=== 1`
> means no other mutations are queued."

```typescript
// Only invalidate when the LAST concurrent mutation settles
onSettled: async () => {
  if (queryClient.isMutating() === 1) {
    await queryClient.invalidateQueries({ queryKey: ['messages'] });
  }
};
```

**DorkOS mapping:** The streaming session is effectively a long-running mutation. The "skip
invalidateQueries after stream" approach is the correct application of this pattern — invalidation
should only happen when there are no other active streaming operations.

### `setQueryData` vs `invalidateQueries` During Streaming

The pattern from `fragmentedthought.com` (React Query + SSE):

```typescript
// SSE handler patches the cache directly — no refetch triggered
queryClient.setQueryData(['messages', sessionId], (old) => ({
  ...old,
  messages: [...old.messages, newMessage],
}));
```

Using `setQueryData` (direct patch) instead of `invalidateQueries` (trigger refetch) is the
canonical way to avoid the flash. When the streaming handler writes directly to the cache, no
network round-trip is needed and there is no stale-data window.

**DorkOS note:** DorkOS uses local React state (`messages` array via `setMessages`) rather than
TanStack Query cache for streaming state. The equivalent of `setQueryData` is the streaming
append that already happens via `setMessages`. The fix correctly keeps this as the source of truth
post-stream.

---

## 3. Event-Sourced Chat Models

### What Client-Side Event Sourcing Means for Chat

Event sourcing on the client means: all state changes (SSE delta events, history fetch results,
user actions) are recorded as an immutable append-only event log. The message list is a pure
derived projection from that log.

```
Event Log:
  [user_message_appended, assistant_streaming_started, text_delta, text_delta, ...,
   history_snapshot_received, assistant_streaming_completed]

Projection (reducer):
  eventLog.reduce((state, event) => {
    switch (event.type) {
      case 'text_delta': return appendToLastAssistant(state, event.text);
      case 'history_snapshot_received': return mergeWithExisting(state, event.messages);
      // ...
    }
  }, initialState)
```

### Real-World Example: Rapport (React/Redux/Elixir)

Rapport, a real-time collaboration app, uses this pattern:

- Phoenix (Elixir) pushes events over WebSocket channels
- Redux actions are the client-side events (every SSE/WS message dispatches an action)
- Redux reducers are the projections
- The message list is derived state, never mutated directly

The "merge history with streaming" problem becomes a reducer concern: when a `history_loaded`
action arrives, the reducer can apply deduplication logic centrally rather than in imperative code.

### Event Sourcing vs Tagged-Dedup: Tradeoffs

| Dimension                | Event Sourcing                                        | Tagged-Dedup (Proposed)                                  |
| ------------------------ | ----------------------------------------------------- | -------------------------------------------------------- |
| Structural change        | Large — new event log type, reducer, projection layer | Minimal — add `_streaming` flag, update dedup logic      |
| Dedup approach           | History events are filtered by log position           | Tagged messages match server messages by role+content    |
| Error part preservation  | Natural — events are never discarded                  | Explicit — client-only parts carried over on dedup match |
| Future extensibility     | Any new event type is trivially addable               | Each new part type must be explicitly preserved in dedup |
| Debuggability            | Excellent — replay log to reproduce any state         | Moderate — must trace flag state across renders          |
| Implementation risk      | High — fundamental data model change                  | Low — additive, backwards-compatible                     |
| Right for these two bugs | No — over-engineers for current need                  | Yes — targeted fix                                       |

### When Event Sourcing Is Worth It

Event sourcing on the client makes sense when:

- Multiple event sources (SSE, WebSocket, polling, user actions) must all contribute to the same
  mutable state
- Time-travel debugging is a requirement
- The projection logic is complex enough to warrant centralization (e.g., collaborative editing)

For a chat UI with two well-characterized bugs, event sourcing is the right **long-term target**
architecture if the codebase grows to support replays, auditing, or multi-agent parallel streams.
It is not the right fix for Bug 1 and Bug 2 today.

---

## 4. Session Remap / ID Reassignment Patterns

### The Universal Pattern: Keep Temp ID as Secondary Attribute

The canonical pattern from production systems (documented in multiple sources):

```typescript
// Step 1: Client creates with temp ID
const tempId = crypto.randomUUID();
const optimisticMessage = { id: tempId, temporaryId: tempId, role: 'user', content };
setMessages((prev) => [...prev, optimisticMessage]);

// Step 2: Server confirms with permanent ID
const serverMessage = await api.send({ content });

// Step 3: Remap — find by temporaryId, update primary id
setMessages((prev) =>
  prev.map((m) =>
    m.temporaryId === tempId ? { ...m, id: serverMessage.id, temporaryId: undefined } : m
  )
);
```

The `temporaryId` stays as a secondary attribute until the remap is complete. After remap, dedup
by primary `id` works correctly.

### Three Setup Strategies for Temp-to-Server ID

1. **Traditional Server (current DorkOS situation):** Server does not know client IDs. Client must
   match temp ID to server ID by some secondary signal (content, timestamp, position). After match,
   client updates the primary ID in-place.

2. **Client-ID Propagation:** Client sends its UUID to the server, which stores both `client_id`
   and `server_id`. Server returns `client_id` in the response, enabling exact matching.
   - DorkOS could adopt this: include `assistantIdRef.current` in the streaming request, have the
     server echo it in the `done` event alongside the JSONL-assigned ID.

3. **Client-Owns-ID:** Server stores whatever ID the client provides (no server-assigned ID). The
   client UUID IS the permanent ID. No remap needed.
   - Not viable for DorkOS — the SDK assigns JSONL IDs independently.

### Strategy 2 is the Long-Term Fix

The remap research report (`20260312_fix_chat_stream_remap_bugs.md`) already identified "Approach D"
(stable assistant ID via server echo) as the correct long-term fix. External research confirms this
is the industry standard — client propagates its UUID, server echoes it in the confirmation event.

For DorkOS specifically:

- Server: include the SDK-assigned JSONL message UUID in the `done` event
- Client: on `done` event, update `assistantIdRef.current` message's `id` to the server-assigned ID
- Result: when polling resumes, ID-based dedup works natively — no tagged-message logic needed

This is more surgical than the tagged-dedup approach but requires server changes.

### How React Query Cache Keys Interact with ID Changes

When the session ID changes (the remap case), the TanStack Query cache key `['messages', sessionId]`
changes. This means:

- The old session's cache entry is abandoned (not invalidated, just orphaned)
- A new cache entry is created for the new session ID
- The new entry starts empty and the background query fetches history

This is the correct behavior — the data for the old session ID is irrelevant once remapped. The
UX problem (empty flash) is a consequence of the cache key change, not a bug in TanStack Query.
The fix is either:

- Keep messages in local state through the remap (don't clear `messages[]`)
- Or show a loading indicator that bridges the gap

The proposed spec Step 4 (keep messages on screen during remap) is correct.

---

# Detailed Analysis

## Is the Tagged-Dedup Approach Standard?

Yes. The "nonce" / "pending marker" / `client_msg_id` pattern is used universally. What varies is
where the dedup check runs:

- **Slack:** dedup check in the WebSocket event handler (server echoes `client_msg_id` back)
- **Vercel AI SDK:** dedup check nowhere — it's an unresolved gap
- **Apollo Client:** dedup check in the mutation `onMutate`/`onSettled` via cache patch
- **RTK Query:** dedup check in the `onCacheEntryAdded` streaming handler via Immer patch
- **DorkOS (proposed):** dedup check in the incremental append path of the seed effect

The DorkOS approach is sound. The industry standard does the same thing — match the temp/optimistic
entity to the server entity and merge in-place rather than replacing the list.

## The "Source of Truth" Question

A common design question: after streaming ends, is the streaming message or the server history the
source of truth?

**All production systems answer: the server is eventually authoritative, but the streaming message
is the immediate display truth.** The reconciliation makes them converge without a visible replace.

In DorkOS:

- **During streaming:** local `messages[]` is truth
- **After streaming:** local `messages[]` remains truth (proposed fix: stop resetting `historySeededRef`)
- **When polling returns:** server history is merged in, with client-only parts preserved

This is correct. The server cannot be truth for data it doesn't persist (errors, subagent parts).

## Content-Based Matching: Is It Reliable Enough?

The proposed spec uses position-from-end matching ("tagged messages are always the last user +
last assistant messages") with content match on the user message as a fallback.

Research finding: this is less reliable than ID-based matching but more reliable than arbitrary
heuristics. The Vercel AI SDK community explicitly flagged content-based reconciliation as fragile
when assistant content differs between streaming state and JSONL serialization.

For DorkOS, the risk is bounded:

- User message content is exact (we submitted it, the server stores it verbatim)
- Assistant message is matched by position relative to the matched user message — no content match
- The tagged set is bounded at 0-2 messages per turn

**Risk level: Low.** The only failure case is if the user submits the exact same content in two
rapid consecutive messages and the server reorders them — vanishingly unlikely in an interactive
chat session.

## RTK Query Streaming Pattern: Applicability

RTK Query's `onCacheEntryAdded` pattern is architecturally superior but requires putting streaming
state inside the TanStack Query cache rather than local React state. DorkOS made a deliberate
choice to keep streaming in local state for performance (no cache subscription overhead on every
delta). This choice is correct for the streaming path.

The proposed fix preserves this architecture. Local state is the streaming truth; polling appends
rather than replaces. This is exactly the RTK Query pattern adapted to the "local state first,
cache second" architecture DorkOS uses.

---

# Recommendation for This Use Case

## Immediate Fix (Tagged-Dedup): Confirmed Correct

The proposed solution (Steps 1-4 in the spec) is:

- Aligned with industry practice (nonce/temp-ID reconciliation)
- Consistent with TanStack Query's "cancel in-flight fetches, don't replace optimistic state"
- Lower risk than any alternative that requires server changes
- Directly fixes both bugs (flash and error part loss)

## Server-Echo ID (Long-Term): Confirmed as the Right Upgrade Path

After the tagged-dedup fix ships, the next iteration should implement Strategy 2 (client-ID
propagation): include the client's `assistantIdRef.current` UUID in the streaming request body,
have the server echo the JSONL-assigned message ID in the `done` event, and update the in-memory
message ID on `done`. This replaces content/position-based matching with exact ID-based matching
and eliminates the need for the `_streaming` tag entirely.

## Event Sourcing: Deferred but Worth Designing For

Event sourcing is the right long-term architecture if DorkOS needs to support:

- Session replay / time-travel debugging for agent runs
- Multi-stream (subagent) parallel message lists
- Audit log / history diffing between streaming state and persisted state

If the codebase moves to event sourcing, the tagged-dedup approach is easily replaced: the
`history_snapshot_received` event becomes just another event type in the log, and the reducer
handles dedup centrally.

**Do not implement event sourcing for these two bugs.** The complexity cost is not justified by
the current requirement.

---

# Sources & Evidence

- **Slack `client_msg_id` pattern**: [Real-time Messaging - Slack Engineering](https://slack.engineering/real-time-messaging/) — confirms Channel Server architecture; [chat.postMessage - Slack API](https://api.slack.com/methods/chat.postMessage) — confirms `client_msg_id` as dedup key
- **Temporary ID patterns**: [Client-Side Temporary IDs - DEV Community](https://dev.to/danielsc/client-side-temporary-ids-5c2k) — three setup strategies, `temporaryId` secondary attribute, reference resolution
- **TanStack Query optimistic patterns**: [Optimistic Updates - TanStack Query Docs](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates) — cancel/snapshot/write/invalidate pattern
- **Concurrent mutations (flash prevention)**: [Concurrent Optimistic Updates in React Query - tkdodo.eu](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query) — `isMutating() === 1` guard for preventing over-invalidation
- **React Query + SSE pattern (setQueryData vs invalidateQueries)**: [React Query caching with Server-Side Events](https://fragmentedthought.com/blog/2025/react-query-caching-with-server-side-events) — `updateCachedData` / `setQueryData` as the correct streaming update mechanism
- **RTK Query streaming updates**: [Streaming Updates - Redux Toolkit](https://redux-toolkit.js.org/rtk-query/usage/streaming-updates) — `onCacheEntryAdded` + `updateCachedData` pattern
- **Vercel AI SDK dual-source problem**: [Guidance on persisting messages - vercel/ai Discussion #4845](https://github.com/vercel/ai/discussions/4845) — confirms the problem is unsolved upstream; appendResponseMessages ID mismatch
- **Vercel AI SDK v5 UIMessage/ModelMessage**: [AI SDK 5 - Vercel](https://vercel.com/blog/ai-sdk-5) — transient parts not persisted, UIMessage as application state truth
- **Event sourcing + React**: [Event Sourcing in React/Redux/Elixir - Rapport Blog](https://medium.com/rapport-blog/event-sourcing-in-react-redux-elixir-how-we-write-fast-scalable-real-time-apps-at-rapport-4a26c3aa7529) — real-world event sourcing for real-time chat
- **CQRS projections**: [Live projections for read models - kurrent.io](https://www.kurrent.io/blog/live-projections-for-read-models-with-event-sourcing-and-cqrs) — projection pattern for read models
- **Optimistic UI React 19 `useOptimistic`**: [Understanding optimistic UI and React's useOptimistic - LogRocket](https://blog.logrocket.com/understanding-optimistic-ui-react-useoptimistic-hook/) — React 19 built-in pattern for temp-ID display
- **Apollo Client optimistic UI**: [Optimistic mutation results - Apollo GraphQL Docs](https://www.apollographql.com/docs/react/performance/optimistic-ui) — field-level in-place replacement after server confirms
- **Prior DorkOS research**: `research/20260307_fix_chat_streaming_history_consistency.md` — auto-scroll and tool result orphan patterns; `research/20260312_fix_chat_stream_remap_bugs.md` — Approach D (server-echo ID) as long-term fix

---

# Research Gaps & Limitations

- **Discord's internal optimistic message pattern** was not found — their Engineering blog does not
  cover client-side message handling at this level of detail.
- **Linear's chat/comment optimistic update pattern** was not found — their engineering blog focuses
  on issue tracking, not messaging.
- **The exact Slack WebSocket protocol** for echoing `client_msg_id` back to the sender was not
  confirmed from official docs (Slack's RTM API is deprecated; Socket Mode docs don't expose this
  detail). The pattern was inferred from multiple community sources and the `chat.postMessage` API
  reference.
- **RTK Query `onCacheEntryAdded` direct applicability to DorkOS** was not prototyped — the analysis
  is structural/theoretical.

---

# Contradictions & Disputes

- **"Content-based dedup is fine" vs "content-based dedup is fragile"**: The spec summary and this
  research both acknowledge content matching is less reliable than ID matching. The risk is bounded
  in DorkOS (exact user message text, position-based assistant match) but the Vercel AI community
  shows real-world failures when content differs between streaming and persisted representations.
  Resolution: use content matching for user messages only; use position matching for assistant
  messages. This is more robust than pure content matching.

- **"Event sourcing is overkill" vs "event sourcing is the right long-term target"**: Both are true
  simultaneously. Event sourcing is overkill for a two-bug fix but is the correct direction if
  DorkOS expands to multi-agent parallel streams, replay, or audit requirements. These are not
  contradictory positions.

---

# Search Methodology

- Searches performed: 13
- Most productive terms: "Slack nonce optimistic message client_msg_id reconciliation", "TanStack
  Query optimistic SSE flash prevent", "client-side temporary IDs server ID reassignment React",
  "event sourcing React Redux Elixir real-time chat", "Vercel AI SDK useChat reconcile streaming
  history ID"
- Primary sources: Slack Engineering blog, TanStack Query docs, tkdodo.eu blog, RTK Query docs,
  GitHub vercel/ai discussions, dev.to temporary ID article, Rapport blog on event sourcing

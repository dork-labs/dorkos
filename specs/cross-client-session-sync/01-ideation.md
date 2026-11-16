---
slug: cross-client-session-sync
number: 25
created: 2026-02-13
status: implemented
---

# Cross-Client Session Synchronization

**Slug:** cross-client-session-sync
**Author:** Claude Code
**Date:** 2026-02-13
**Branch:** preflight/cross-client-session-sync
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Investigate options for keeping the chat message list in sync across multiple clients viewing the same session. Two scenarios: (1) CLI activity reflected in the WebUI without refresh, (2) same session open in multiple browser tabs/devices with both staying current.

**Assumptions:**

- Single server instance (no horizontal scaling needed)
- Local-first architecture (no cloud dependencies)
- JSONL transcript files are the single source of truth
- Append-only message log (no edits/deletes to existing messages)
- CLI writes directly to JSONL files — these changes do NOT flow through the TypeScript Agent SDK's streaming API
- Near-real-time sync is desirable but sub-second latency is not strictly required

**Out of scope:**

- Multi-user collaboration features (shared cursors, presence)
- Conflict resolution for simultaneous message sends from multiple clients
- Server-side changes to the Claude Agent SDK
- Horizontal scaling / multi-server deployments
- Real-time sync of tool approval state across clients (only message content)

---

## 2) Pre-reading Log

- `apps/server/src/services/stream-adapter.ts`: SSE helper functions (`initSSEStream`, `sendSSEEvent`, `endSSEStream`). Writes `event: {type}\ndata: {JSON}\n\n` format. No broadcast capability — writes to a single `res` object.
- `apps/server/src/services/transcript-reader.ts`: Reads JSONL files from `~/.claude/projects/{slug}/{sessionId}.jsonl`. Has metadata cache with mtime invalidation. `readTranscript()` does full file read every time (`fs.readFile`). No streaming or incremental reads.
- `apps/server/src/services/agent-manager.ts`: Manages SDK sessions. `sendMessage()` returns `AsyncGenerator<StreamEvent>`. In-memory session Map. No concurrency control — two concurrent `sendMessage()` calls on the same session create two SDK queries (race condition). No mechanism to notify other clients.
- `apps/server/src/routes/sessions.ts`: POST `/messages` creates SSE stream for the sending client only. GET `/messages` reads full JSONL. No subscription/streaming endpoint for passive listeners.
- `apps/client/src/hooks/use-chat-session.ts`: TanStack Query fetches history once (`staleTime: 5min`, `refetchOnWindowFocus: false`). State seeded from history via `historySeededRef`, then updated only during active streaming. No polling or push subscription.
- `apps/client/src/lib/http-transport.ts`: `sendMessage()` opens fetch with ReadableStream reader. One SSE connection per POST. No persistent connection. No EventSource usage.
- `packages/shared/src/transport.ts`: Pull-based interface. 9 methods, all request-response. No subscription/push mechanism.
- `packages/shared/src/schemas.ts`: StreamEvent types: `text_delta`, `tool_call_start/delta/end`, `tool_result`, `approval_required`, `question_prompt`, `error`, `done`, `session_status`, `task_update`. No sync-related events.
- `guides/interactive-tools.md`: Documents deferred promise pattern for tool approval. Relevant because sync would need to handle interactive tool state.

---

## 3) Codebase Map

**Primary components/modules:**

| File                                            | Role                                                 |
| ----------------------------------------------- | ---------------------------------------------------- |
| `apps/server/src/services/stream-adapter.ts`    | SSE wire protocol helpers (1:1 response)             |
| `apps/server/src/services/transcript-reader.ts` | Reads JSONL files, session metadata with mtime cache |
| `apps/server/src/services/agent-manager.ts`     | SDK session lifecycle, `sendMessage()` generator     |
| `apps/server/src/routes/sessions.ts`            | REST/SSE endpoints for sessions and messages         |
| `apps/client/src/hooks/use-chat-session.ts`     | Client chat state, history loading, streaming        |
| `apps/client/src/lib/http-transport.ts`         | HTTP + SSE transport adapter                         |
| `packages/shared/src/transport.ts`              | Transport interface (pull-based)                     |
| `packages/shared/src/schemas.ts`                | Zod schemas for all event/message types              |

**Shared dependencies:**

- TanStack Query v5 (client data fetching, has built-in `refetchInterval`)
- Zustand (client UI state)
- Express 4.21 (server routing, response handling)
- No WebSocket, file watching, or pub/sub libraries installed

**Data flow (current):**

```
Client A sends message
  → POST /api/sessions/:id/messages
  → agentManager.sendMessage() → SDK query() → claude CLI process
  → SDK streams events → AsyncGenerator<StreamEvent>
  → SSE response to Client A only
  → SDK writes to JSONL file on disk

Client B viewing same session:
  → Sees nothing (no push mechanism, history stale after initial load)

CLI user on same session:
  → claude CLI writes directly to JSONL
  → Server has no knowledge of the change
  → WebUI sees nothing
```

**Potential blast radius:**

- Transport interface (`packages/shared/src/transport.ts`) — would need new subscription method
- SSE streaming (`stream-adapter.ts`, `routes/sessions.ts`) — new broadcast endpoint
- Client chat hook (`use-chat-session.ts`) — subscribe to updates or poll
- Agent manager (`agent-manager.ts`) — emit events for broadcast
- Schemas (`schemas.ts`) — new sync event types

---

## 4) Root Cause Analysis

N/A — this is a feature investigation, not a bug fix.

**However, key architectural constraints identified:**

1. **No file watching**: The server never monitors JSONL files for external changes. CLI writes are completely invisible.
2. **No broadcast mechanism**: SSE responses are 1:1 (one response object per sending client). No way to push to passive listeners.
3. **No persistent connections**: Clients connect only when sending messages. No long-lived SSE or WebSocket for receiving updates.
4. **No write coordination**: Two clients sending to the same session simultaneously creates two SDK query processes, both writing to the same JSONL file (potential corruption).
5. **SDK limitation**: The TypeScript Agent SDK's streaming API only provides events for queries initiated through it. CLI-originated activity writes directly to JSONL and is not observable through the SDK.

---

## 5) Research

### Potential Solutions

**1. Chokidar File Watching + better-sse Channels (Recommended)**

- Description: Watch JSONL files with chokidar for changes (including CLI writes), parse new lines, broadcast to all connected clients via better-sse channel abstraction over SSE.
- Pros:
  - Sub-100ms latency (native OS file events: fsevents on macOS, inotify on Linux)
  - Handles both scenarios (CLI→WebUI and WebUI→WebUI)
  - Leverages existing SSE infrastructure
  - better-sse provides channel abstraction with auto-cleanup on disconnect
  - In-process EventEmitter pattern is perfect for single-server deployment
  - ~200 lines of new code
- Cons:
  - New dependency (chokidar ~12MB, better-sse ~50KB)
  - Need incremental JSONL parsing (read only new lines, not full file)
  - chokidar's `awaitWriteFinish` may add small delay for partially-written lines
  - Electron/Obsidian plugin compatibility unknown (file watching in Electron can be tricky)
- Complexity: Medium
- Maintenance: Low

**2. TanStack Query Smart Polling (Simple Fallback)**

- Description: Use TanStack Query's built-in `refetchInterval` to periodically re-fetch message history from the existing GET endpoint.
- Pros:
  - Zero server changes — uses existing endpoint
  - Trivial to implement (~10 lines of client code)
  - Works in all environments (no file watching needed)
  - Can use adaptive intervals (faster when active, slower when idle)
  - ETag support possible for 304 Not Modified responses
- Cons:
  - 2-10 second latency (polling interval)
  - Higher server load (full JSONL read on every poll)
  - Wasteful when nothing has changed
  - Doesn't scale well with many concurrent sessions
- Complexity: Low
- Maintenance: Low

**3. Hybrid: Polling + SSE for Active Streams**

- Description: Keep current SSE for the message sender. Add polling for passive clients. When a client is actively streaming, other clients poll; when streaming ends, all poll.
- Pros:
  - Minimal server changes
  - Sender gets real-time; others get near-real-time
  - Progressive enhancement over current system
- Cons:
  - Doesn't solve CLI→WebUI (CLI doesn't trigger SSE)
  - Still wasteful polling for passive clients
  - Complex state management (which clients are streaming vs. polling?)
- Complexity: Low-Medium
- Maintenance: Low

**4. WebSocket (Full Bidirectional)**

- Description: Replace or supplement SSE with WebSocket connections for real-time bidirectional communication.
- Pros:
  - Lowest latency (5-50ms)
  - Full bidirectional (could enable collaborative features later)
  - Built-in connection management
- Cons:
  - Significant new infrastructure (ws or socket.io)
  - Overkill — we only need server→client push
  - Doesn't natively solve file watching (still need chokidar for CLI scenario)
  - No auto-reconnect (must implement manually, unlike EventSource)
  - Higher maintenance burden
- Complexity: High
- Maintenance: High

**5. node-tail + In-Process EventEmitter**

- Description: Use `node-tail` library to tail JSONL files (like `tail -f`), emit new lines via Node.js EventEmitter, push to connected SSE clients.
- Pros:
  - Lightweight, focused on append-only files
  - Zero-dependency (node-tail is small)
  - EventEmitter pattern familiar and well-understood
- Cons:
  - More manual lifecycle management than better-sse channels
  - Must handle client tracking, cleanup, reconnection manually
  - node-tail less battle-tested than chokidar for cross-platform
- Complexity: Medium
- Maintenance: Medium

**6. CRDT (Yjs/Automerge)**

- Description: Use conflict-free replicated data types for message synchronization.
- Pros:
  - Handles concurrent writes elegantly
  - Offline-first with automatic merge
- Cons:
  - Massive overkill for append-only chat log
  - Ever-growing CRDT file sizes
  - Requires completely new data model (not JSONL)
  - Huge new dependency
- Complexity: Very High
- Maintenance: High

**7. Managed Real-Time Service (Ably, Pusher, etc.)**

- Description: Use a cloud service for real-time message broadcasting.
- Pros:
  - Zero infrastructure, proven at scale
  - Handles reconnection, buffering, delivery guarantees
- Cons:
  - Conflicts with local-first philosophy
  - Adds cloud dependency and cost
  - Privacy concerns (messages transit through third party)
  - Still needs file watching for CLI scenario
- Complexity: Low (integration)
- Maintenance: Low (managed)

### Recommendation

**Primary: Chokidar + better-sse Channels (#1)**

This is the best fit because:

- Solves both scenarios with a single mechanism
- Leverages existing SSE infrastructure rather than adding WebSocket
- Native file watching catches CLI writes that the SDK can't observe
- better-sse channels handle multi-client broadcasting with auto-cleanup
- In-process EventEmitter is ideal for single-server local-first architecture
- Low latency (sub-100ms) without polling overhead

**Fallback: TanStack Query Smart Polling (#2)**

If file watching proves problematic (Electron compat, performance, etc.), polling is the simplest backup:

- 10 lines of code, zero server changes
- 80% of the benefit with 20% of the effort
- Can be implemented as Phase 1 while building toward file watching

### Architecture Sketch (Recommended Approach)

```
┌─────────────────────────────────────────────────┐
│                    Server                        │
│                                                  │
│  ┌──────────────┐    ┌───────────────────────┐  │
│  │  Chokidar    │───▶│  SessionBroadcaster   │  │
│  │  File Watcher│    │  (EventEmitter)        │  │
│  └──────────────┘    │                        │  │
│        ▲             │  sessionChannels Map   │  │
│        │             │  sessionId → Channel   │  │
│  JSONL changes       │                        │  │
│  (CLI or SDK)        └───────┬───────────────┘  │
│                              │                   │
│                    ┌─────────▼──────────┐        │
│                    │  better-sse        │        │
│                    │  Channel.broadcast()│       │
│                    └─────────┬──────────┘        │
│                              │                   │
│                    SSE push to all clients        │
└──────────────────────┬──────┬────────────────────┘
                       │      │
              ┌────────▼┐  ┌──▼────────┐
              │ Client A │  │ Client B  │
              │ (Desktop)│  │ (Mobile)  │
              │ EventSrc │  │ EventSrc  │
              └──────────┘  └───────────┘
```

**New SSE endpoint:** `GET /api/sessions/:id/stream`

- Persistent EventSource connection (not tied to sending a message)
- Client connects when viewing a session
- Receives all new messages regardless of source (CLI, SDK, other client)

**New server components:**

- `services/session-broadcaster.ts` — manages channels, file watchers, and broadcasting
- Extends `transcript-reader.ts` with incremental reading (track file offset per session)

**New client hook or extension:**

- `useSessionSync(sessionId)` — connects EventSource, merges incoming messages into chat state
- Or extend `useChatSession` with an EventSource subscription alongside existing streaming

---

## 6) Clarifications

1. **Polling vs. file watching priority?**
   Should we implement the simpler polling approach first (Phase 1) and add file watching later (Phase 2)? Or go straight to file watching?
   - Polling: works immediately, ~10 lines, but 2-10s latency
   - File watching: sub-100ms, but more code and new dependencies

2. **Concurrent send protection?**
   Currently, two clients can send messages to the same session simultaneously, causing race conditions (two SDK query processes writing to the same JSONL). Should this feature also add a "session lock" so only one client can send at a time? Or is that a separate concern?

3. **Scope of sync events?**
   Should we sync everything (text deltas, tool calls, tool results, approval requests) or just completed messages? Syncing everything enables a passive client to see streaming text in real-time. Syncing only completed messages is simpler but means passive clients see messages appear all-at-once.

4. **Transport interface changes?**
   The Transport interface is shared between HttpTransport (web) and DirectTransport (Obsidian). Should the sync mechanism be added to the Transport interface (requires both implementations), or only to HttpTransport?

5. **Obsidian plugin compatibility?**
   File watching in Electron (Obsidian) can behave differently. Should we support sync in the Obsidian plugin, or only in standalone web mode?

6. **better-sse vs. roll-our-own?**
   better-sse adds a dependency but provides channel abstraction, auto-cleanup, and session tracking. We could also implement broadcasting manually with a Map of Response objects. Preference?

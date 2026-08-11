---
number: 104
title: Client-Side Message Queue with Auto-Flush
status: superseded
created: 2026-03-10
spec: chat-input-always-editable
superseded-by: 260811-184735
---

# 0104. Client-Side Message Queue with Auto-Flush

## Status

Superseded by ADR 260811-184735 (2026-08-11, spec `persistent-session-runtime` P2): the queue moved out of the browser and onto the server, where it is persisted, visible to every window, and editable from any of them.

Replaced for durability and multi-window reach, not out of dissatisfaction. A client-only queue was the correct trade when this was written — it needed no server change and it shipped — and the shell-history editing model it introduced is the model the server-owned queue keeps. What ended it is that all four of its own Negative consequences are properties of living in a tab: ephemerality, no server awareness, a flush lifecycle only the client could see, and a client API that could not be reached from a second window.

## Context

The DorkOS chat input is disabled during agent streaming, preventing users from drafting follow-up messages. Power users (Kai: 10-20 sessions/week) lose flow and forget thoughts while waiting. Competing tools like Roo Code and Relevance AI have introduced message queuing, but with limited editing capabilities. The Claude Agent SDK supports sequential message delivery via streaming input mode, making a client-side queue technically viable without server changes.

## Decision

Implement a client-side FIFO message queue (`useMessageQueue` hook) that collects user messages during streaming and auto-flushes them sequentially when the agent becomes idle. The queue is ephemeral (no persistence), client-only (no server changes), and respects both `sessionBusy` server locks and the relay `waitForStreamReady` handshake between flushes. Queued messages are prepended with a timing annotation to prevent context misinterpretation by the agent.

## Consequences

### Positive

- Zero server-side changes — queue is entirely React state
- Compatible with both legacy SSE and relay message paths
- Auto-flush respects existing concurrency controls (ADR-0075 promise chain, `waitForStreamReady`)
- Timing annotations solve the known context misinterpretation issue for queued messages
- Shell-history editing model provides novel UX that maps to developer mental models

### Negative

- Queue is ephemeral — lost on page refresh, session change, or CWD change
- No server awareness of queued messages — if the client crashes mid-queue, remaining items are lost
- Auto-flush adds complexity to the status transition lifecycle (streaming → idle triggers flush → streaming again)
- `submitContent` method extends `useChatSession`'s public API surface

---
number: 263
title: Runtime-Neutral Session Snapshot & Event-Stream Contract with Pluggable Persistence
status: draft
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 263. Runtime-Neutral Session Snapshot & Event-Stream Contract with Pluggable Persistence

## Status

Draft (auto-extracted from spec: chat-stream-reconnection)

## Context

DorkOS reads Claude Code JSONL directly for session history (`getMessageHistory` → `transcript-reader.ts`), live deltas (`session-broadcaster.ts` file-watch), and the session list (`unified-scanner.ts`). AGENTS.md even states "Sessions derive entirely from SDK JSONL files." This does not generalize to future runtimes (OpenCode, Codex) that may run per-turn (non-persistent), store history in another format, or store nothing at all. The client and server should behave identically regardless of runtime, and a stateless runtime must still be fully supported.

## Decision

DorkOS owns a runtime-neutral **session snapshot + event-stream contract** at the `AgentRuntime` boundary — `getSessionSnapshot()`, `subscribeSession()`, `subscribeSessionList()` emitting normalized, monotonically-`seq`'d `SessionEvent`s — but **persistence is pluggable per adapter** ("own the boundary, not the bytes"). The Claude adapter backs the contract with its native JSONL (lazy `loadHistory` + file-watch mapped to events); a stateless adapter backs it with a DorkOS-owned append-only EventLog (persisting the events the server already buffers). Server and client never branch on which runtime is active. The contract is proven end-to-end in this spec by a stateless, log-backed stub adapter.

## Consequences

### Positive

- One client/server code path works across persistent and non-persistent, file-based and storeless runtimes.
- Avoids double-writing or diverging from Claude Code's own complete transcripts.
- Stateless runtimes get full history/liveness for free from the buffered event stream.

### Negative

- Adds a new abstraction layer (projector + contract) the server must maintain.
- Two adapter persistence strategies (native-backed vs DorkOS-log-backed) to keep behaviorally consistent; the shared contract + stub-adapter tests mitigate drift.
- `seq` must be assigned by DorkOS (not derived from JSONL line numbers) to stay uniform across runtimes.

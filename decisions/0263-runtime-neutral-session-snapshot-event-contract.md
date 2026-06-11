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

The event union has a **required core and an optional fidelity tier**. Core members (text/tool/interaction/status/todo/subagent/turn boundaries, `interaction_resolved`) every adapter must emit for the projection to be correct. Fidelity members — `thinking_delta`, `tool_progress`, `hook_update`, `memory_recall` — exist so a LIVE turn renders with the same detail as the post-turn history reload; adapters with no equivalent concept simply omit them and clients degrade to a lean render with no behavioral branch. Multi-phase adapter events collapse into single upsert-by-id members (`hook_update` keyed by `hookId`, `subagent_update` keyed by `taskId`) rather than mirroring per-phase event names, keeping the union small and replay-idempotent.

`interaction_resolved.resolution` covers non-operator outcomes too: `cancelled` means the runtime aborted the gating call (a mid-turn steered message superseding a pending question, an interrupt) or the interaction expired — emitted so projections drop the card instead of presenting an answerable ghost until the expiry timer (browser acceptance 2026-06-10, finding F5).

## Consequences

### Positive

- One client/server code path works across persistent and non-persistent, file-based and storeless runtimes.
- Avoids double-writing or diverging from Claude Code's own complete transcripts.
- Stateless runtimes get full history/liveness for free from the buffered event stream.

### Negative

- Adds a new abstraction layer (projector + contract) the server must maintain.
- Two adapter persistence strategies (native-backed vs DorkOS-log-backed) to keep behaviorally consistent; the shared contract + stub-adapter tests mitigate drift.
- `seq` must be assigned by DorkOS (not derived from JSONL line numbers) to stay uniform across runtimes.

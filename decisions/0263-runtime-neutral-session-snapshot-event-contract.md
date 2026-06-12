---
number: 263
title: Runtime-Neutral Session Snapshot & Event-Stream Contract with Pluggable Persistence
status: proposed
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 263. Runtime-Neutral Session Snapshot & Event-Stream Contract with Pluggable Persistence

## Status

Proposed — 2026-06-11 (implemented by spec: chat-stream-reconnection; updated post-implementation to record the decision as built)

## Context

DorkOS read Claude Code JSONL directly for session history (`getMessageHistory` → `transcript-reader.ts`), live deltas (file-watch broadcasting), and the session list (`unified-scanner.ts`). This did not generalize to future runtimes (OpenCode, Codex) that may run per-turn (non-persistent), store history in another format, or store nothing at all. The client and server should behave identically regardless of runtime, and a stateless runtime must still be fully supported.

## Decision

DorkOS owns a runtime-neutral **session snapshot + event-stream contract** at the `AgentRuntime` boundary — `getSessionSnapshot()`, `subscribeSession()`, `subscribeSessionList()` — defined in `packages/shared/src/session-stream.ts` (`SessionEventSchema`, `SessionSnapshotSchema`, `SessionListEventSchema`, `StaleResumeCursorError`). **Persistence is pluggable per adapter** ("own the boundary, not the bytes"): the history loader is injected into `SessionStateProjector.buildSnapshot` (`apps/server/src/services/session/session-state-projector.ts`) — the Claude adapter passes a JSONL-backed loader; a log-backed adapter passes an EventLog-derived loader (`event-log-history.ts`). Server and client never branch on which runtime is active. The contract is proven end-to-end by the stateless `TestModeRuntime` (`apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts`), whose only history source is the DorkOS-owned `EventLog`.

`seq` is **assigned by the projector** (`ingest()` stamps `seq = ++counter`), never derived from JSONL line numbers, so file-backed and log-backed runtimes expose a uniform snapshot-then-replay cursor. Adapters emit `seq`-less `RawSessionEvent`s; the normalizer (`session-event-normalizer.ts`) is a deliberate second, lossy hop that folds the larger `StreamEvent` union into the smaller session-stream contract, dropping events with no durable projection.

The 16-member event union has a **required core and an optional fidelity tier**. Core members (text/tool/interaction/status/todo/subagent/turn boundaries, `interaction_resolved`) every adapter must emit for the projection to be correct. Fidelity members — `thinking_delta`, `tool_progress`, `hook_update`, `memory_recall` — exist so a LIVE turn renders with the same detail as the post-turn history reload; adapters with no equivalent concept simply omit them and clients degrade to a lean render with no behavioral branch. Multi-phase adapter events collapse into single upsert-by-id members (`hook_update` keyed by `hookId`, `subagent_update` keyed by `taskId`) rather than mirroring per-phase event names, keeping the union small and replay-idempotent.

`turn_start` carries the triggering `userMessage` (optional — externally-driven turns have no DorkOS-observed trigger): the POST is trigger-only (ADR-0264), so the durable stream is the only delivery path, and for a log-backed runtime the EventLog is the only persistence — without it, reconstructed history would hold answers with no questions.

`interaction_resolved.resolution` covers non-operator outcomes too: `cancelled` means the runtime aborted the gating call (a mid-turn steered message superseding a pending question, an interrupt) or the interaction expired — emitted so projections drop the card instead of presenting an answerable ghost until the expiry timer (browser acceptance 2026-06-10, finding F5).

### Excluded members: `subagent_text_delta` and `permission_denied`

Two `StreamEvent` types the Claude adapter still emits are **deliberately excluded** from the live contract — the normalizer's default case maps them to `null` and drops them:

- **`subagent_text_delta`** (live inner text of a running subagent): subagent lifecycle rides `subagent_update` (`status`, `toolUses`, `lastToolName`, `summary`) without the inner text stream.
- **`permission_denied`** (a classifier/SDK denial resolved before `canUseTool`): operator denials reach live clients via `interaction_resolved {resolution: 'denied'}` (the client settles the tool part to `error` — `project-session-turn.ts`), and the denied call's error result is durable in reconstructed history. The dedicated `PermissionDeniedPart` schema and `PermissionDeniedChip` renderer are retained, but the new pipeline currently has no producer for that part — classifier-denial chips do not render from the live stream.

Rationale: both are fidelity nice-to-haves, and every member added to the contract is surface that ALL future adapters, the projector, replay, and the client projection must carry forever. They are recorded here as known fidelity losses relative to the old in-band POST stream, and are the first candidates for a future contract revision if the gap proves user-visible.

## Consequences

### Positive

- One client/server code path works across persistent and non-persistent, file-based and storeless runtimes — proven by `TestModeRuntime` passing the same flows as Claude.
- Avoids double-writing or diverging from Claude Code's own complete transcripts; stateless runtimes get history/liveness for free from the buffered event stream.
- Every frame is Zod-validated at both ends (`SessionListBroadcaster.broadcast`, client `StreamManager`), so contract drift surfaces as logged drops, not corrupt projections.

### Negative

- Adds an abstraction layer (projector + normalizer + contract) the server must maintain; the normalizer is a second lossy mapping hop after the adapter's own SDK→`StreamEvent` mapping.
- Two adapter persistence strategies (native-backed vs DorkOS-log-backed) to keep behaviorally consistent; the shared contract + stateless-runtime tests mitigate drift. The log-backed history fold is deliberately lower-fidelity (no parts interleaving, no thinking) and depth-bounded by `EVENT_LOG_MAX_EVENTS`.
- The excluded members are real fidelity regressions (no live subagent inner text; no live classifier-denial chip) accepted to keep the contract small.

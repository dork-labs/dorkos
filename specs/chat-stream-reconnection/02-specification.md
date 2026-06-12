---
slug: chat-stream-reconnection
number: 255
created: 2026-06-10
status: specification
authors: [Claude Code]
linear-project: Chat Session Reliability
folds-in: [DOR-74, DOR-81]
unblocks: [DOR-77]
trivializes: [DOR-75, DOR-76]
---

# Runtime-Agnostic Session Hydration & Resumable Streaming

## Status

Specification

## Overview

When the DorkOS client loads, hard-refreshes, or switches sessions, it must immediately reflect the **accurate current state** of every agent and session and **continue receiving streamed events** without gaps. Today it does neither reliably: the live token stream is bound to the lifecycle of the `POST /api/sessions/:id/messages` request, the per-session reconnection stream is gated behind an off-by-default "Multi-window sync" toggle, the sidebar/status surfaces poll on a timer, and "current state" is reconstructed only from Claude Code's on-disk JSONL plus transient in-memory server maps.

This spec replaces that with a **server-owned, always-on, resumable per-session stream** and a **global multiplexed status stream**, both built on a **runtime-neutral session snapshot + event-stream contract** at the `AgentRuntime` boundary. The server becomes the durable mediation layer: it runs turns, buffers their events for replay, projects per-session live state, and serves a gap-free `snapshot → replay → live` stream that any client (the sender, another window, a refreshed tab) attaches to and is immediately correct. Because the contract is runtime-neutral with pluggable persistence, the same client and server code behave identically across the current Claude Code runtime and future runtimes (OpenCode, Codex) — whether they run persistently or per-turn, store history as JSONL, in another format, or not at all.

This generalizes DOR-73 / ADR-0262 (pending-interaction recovery) from one event class to **all** session state, and folds in DOR-74 (canonical session id) and DOR-81 (queued-message session scoping) as prerequisites.

## Background / Problem Statement

Reproduced under the user's real configuration (both Advanced toggles off) and confirmed in code during ideation (`specs/chat-stream-reconnection/01-ideation.md` §4):

- **Reconnection is gated behind an off-by-default flag.** `use-session-history.ts:157` returns `null` for `syncUrl` unless `enableCrossClientSync` ("Multi-window sync", default `false` at `app-store-helpers.ts:85`) is on, so `GET /api/sessions/:id/stream` is **never opened**. With it off, Path B re-emit, `presence`, and `sync_update` are all dead. `use-session-history.ts:99` disables history polling unless `enableMessagePolling` ("Background refresh", default `false`). A refreshed or non-sending client therefore does one JSONL history fetch on mount and then goes deaf.
- **No durable, reattachable stream.** Live tokens stream **in-band on the POST** to `/messages`. A mid-turn hard-refresh kills that request and has nothing to reattach to; the turn only reappears once written to JSONL. DOR-73's hard-refresh case survives **only** because its Path A pull (`use-pending-interactions.ts`) is flag-independent — nothing else shares that property.
- **Runtime-coupled state.** History (`runtime.getMessageHistory` → `transcript-reader.ts`), live deltas (`session-broadcaster.ts` file-watch), and the session list (`packages/mesh/src/discovery/unified-scanner.ts`) all assume Claude Code's JSONL on disk. A stateless or non-JSONL runtime breaks all three.
- **Status & sidebar drift.** `ChatStatusSection.tsx` computes context usage/cost/cache from in-memory store state that is `null` on cold load until the next live event; the sidebar list polls every 5s and can't reflect new/external sessions promptly.
- **Component-scoped state leaks across switches.** `ChatPanel` does not remount on `?session=` change (no `key={sessionId}`); the compose-next queue lives in component-local `useState` and an auto-flush effect fires on a phantom streaming→idle transition, delivering a queued message to the **wrong** session (DOR-81). A client-generated UUID in the URL differs from the runtime's canonical session id (DOR-74), so a session is reachable by two ids — a hazard for URL-entry/refresh hydration.

## Goals

1. **Hard refresh / URL entry** loads the accurate current state of an in-progress session and continues streaming seamlessly, including a turn that is still generating server-side (requirement #1).
2. **Navigating between sessions** loads each session's state and continues streaming; session-scoped state (messages, queue, todos, pending interactions) never leaks across a switch (requirement #2; fixes DOR-81).
3. **Sidebar agent/session list** is accurate immediately after a hard refresh and live-updates without timer polling, including sessions driven outside DorkOS (requirement #3).
4. **Status items** (context usage, cost, cache, model, permission mode, todo counts) reload to their most recent values on refresh and on session switch (requirement #4).
5. **Runtime-agnostic by construction**: server and client never branch on which runtime is active; a stateless, non-JSONL runtime is proven to work end-to-end in this spec.
6. **Correctness is never gated by a feature flag.** Hydration + live streaming are always on.

## Non-Goals

- **Cross-server-restart durability of an in-flight turn.** The in-progress turn's replay buffer is in-process; a server restart aborts the active turn (the runtime query/`canUseTool` promise cannot be resurrected — consistent with ADR-0262). On restart the client hydrates completed state from the snapshot and shows the in-flight turn as interrupted. Accepted loss boundary.
- **Redis-backed buffering, multi-instance fan-out, WebSocket.** Deferred; revisit if DorkOS goes hosted/multi-user. SSE remains the transport.
- **Final polish of DOR-75 (sidebar title disambiguation) and DOR-76 (task-count visual).** This spec makes their data sources settled/correct (stable id, settled todo state) so they become trivial follow-ons, but their UI polish is out of scope here.
- **DOR-80** (Radix rename focus bug) — unrelated.
- **A second _real_ runtime integration** (Codex/OpenCode). This spec designs the contract and proves it with a stateless **stub** adapter; wiring a real runtime is follow-on work.

## Technical Dependencies

- Internal only — no new external libraries. SSE via the existing fetch-based `SSEConnection` (`layers/shared/lib/transport/sse-connection.ts`, already supports custom `Last-Event-ID` headers), Express routes, the `AgentRuntime` (`packages/shared/src/agent-runtime.ts`) and `Transport` (`packages/shared/src/transport.ts`) seams, `@dorkos/shared` Zod schemas, React 19 + TanStack Query + Zustand.
- Extends/generalizes ADR-0262 (DOR-73 hybrid pull + SSE re-emit) and ADR-0117 (Direct SSE as sole web transport).
- Reuses prior art: `specs/session-state-manager` (#190, StreamManager pattern), `specs/cross-client-session-sync` (#25), `specs/chat-streaming-session-reliability` (#93).
- Local research already covering large parts of the design: `research/20260328_session_state_manager_architecture.md`, `research/20260327_sse_multiplexing_unified_stream.md`, `research/20260327_sse_singleton_strictmode_hmr.md`, `research/20260306_sse_relay_delivery_race_conditions.md`, `research/20260324_sse_resilience_production_patterns.md`, `research/20260319_streaming_message_integrity_patterns.md`, `research/20260327_fetch_sse_transport_migration.md`.

## Detailed Design

### Architecture (target)

```
 Runtime adapter              DorkOS server (persistent mediator)              Client
 (Claude / stub / future)     ─────────────────────────────────────           ──────
   native events  ─────►  SessionStateProjector  (one per live session)
                            • live state: in-progress turn parts, status
                              (context/cost/cache/model/mode), pending
                              interactions, todos, running subagents
                            • EventLog: monotonically-seq'd SessionEvents
                            • RingBuffer: current-turn events (TTL after turn-end)
   native history ◄─────  SnapshotAssembler
   (loadHistory)             getSnapshot(id) = completed messages
                             (native store OR DorkOS log) + live state + cursor
                                    │
                             Durable per-session SSE  /api/sessions/:id/events
                             (ALWAYS-ON; emits: snapshot → gap-replay (Last-Event-ID
                             / ?after=cursor) → live; id: <sid>-<seq> per frame)
                                    │                                          ┌── StreamManager (module singleton)
                             Global status SSE  /api/events                    │   • owns SSE across route/StrictMode/
                             (agent_status, session_upserted/removed, ─────────┤     session changes; idempotent apply
                              presence) — server-discovered incl. external     │     by seq → Zustand Record<id,State>
                                                                               └── React reads via useSyncExternalStore
```

### A. Runtime-neutral contract (`packages/shared/src/agent-runtime.ts` + `transport.ts`)

DorkOS owns the abstraction; adapters own persistence. Add to the `AgentRuntime` interface:

- `getSessionSnapshot(ctx, sessionId): Promise<SessionSnapshot>` — the authoritative current state: `{ messages: HistoryMessage[]; inProgressTurn: SessionEvent[] | null; status: SessionStatus; pendingInteractions: PendingInteractionDTO[]; cursor: number }`. The adapter decides where `messages` come from (Claude: `loadHistory()` from JSONL; stub/stateless: the DorkOS-owned EventLog).
- `subscribeSession(ctx, sessionId, sinceCursor?): AsyncIterable<SessionEvent>` — normalized, monotonically-seq'd events for one session: `text_delta`, `tool_call`, `tool_result`, `approval_required | question_prompt | elicitation_prompt`, `status_change`, `todo_update`, `subagent_update`, `turn_start`, `turn_end`. Replaces the bespoke `sync_update`/in-band split. The adapter maps its native source (Claude: file-watch + the in-band SDK query it already runs; stub: its in-process turn loop) into this stream.
- `subscribeSessionList(ctx): AsyncIterable<SessionListEvent>` — `session_upserted | session_removed | session_status` for discovery + liveness across **all** sessions the adapter can observe, including externally-driven ones (Claude adapter watches the `~/.claude/projects` tree; future adapters expose their own). Feeds the global status stream.

`SessionEvent` carries a per-session monotonic `seq` (assigned by the projector, **not** derived from JSONL line numbers — uniform across file-backed and log-backed runtimes). `SessionSnapshot.cursor` is the highest `seq` reflected in the snapshot. Apply is idempotent: an event with `seq <= state.lastAppliedSeq` is a no-op, so replay and live can overlap without dupes or gaps. The existing `getMessageHistory` is retained and called by the Claude adapter's `loadHistory()`; it is no longer the client-facing mechanism.

These surface through `Transport` as `getSessionSnapshot`, the SSE `subscribeSession` (HTTP: `GET /api/sessions/:id/events`; Direct/Obsidian: in-process async iteration), and `subscribeSessionList` (`GET /api/events`).

### B. Server — projector, ring buffer, durable stream (`apps/server/src/`)

1. **`SessionStateProjector`** (new, `services/session/`): one per live session. Consumes the adapter's `subscribeSession`, assigns `seq`, updates the live-state projection (in-progress turn parts, status, pending interactions, todos, subagents), appends to an in-process **EventLog** and a bounded **RingBuffer** (current turn only; retained for a TTL after `turn_end` to absorb hard-refresh races). The DOR-73 `pendingInteractions` map is absorbed into the projection (its `remainingMs`/expiry selector is preserved).
2. **Turn execution decoupled from the POST.** `POST /api/sessions/:id/messages` becomes _enqueue/trigger_ only: it validates, appends the user message, and starts (or queues) the turn on the server, returning quickly (`202` + the canonical id). The turn's tokens flow through the projector to the durable stream — the **single** delivery path. (Migration sequencing in Phase 2 ensures no double-delivery.)
3. **Durable per-session SSE — `GET /api/sessions/:id/events`** (replaces the gated `/stream`): on connect, send `getSessionSnapshot` (or, if the client passes `Last-Event-ID: <sid>-<seq>` / `?after=`, skip the snapshot and replay from the RingBuffer/EventLog), then switch to live. Emit `id: <sid>-<seq>` per frame, `: keepalive` every ~15s, `X-Accel-Buffering: no`. **Always on**, independent of any toggle. Pending-interaction recovery is now just normal snapshot+replay (DOR-73 Path A/B collapse into one mechanism).
4. **Global status SSE — `GET /api/events`**: multiplexed `agent_status`, `session_upserted`, `session_removed`, `presence` from `subscribeSessionList`. Server-discovered, so externally-driven sessions (Claude Code CLI) appear live without client polling. Replaces the 5s sidebar poll and the per-session-status-via-message-poll path.
5. **Canonical session id (DOR-74).** Resolve the client UUID to the runtime's canonical id at session creation/first message; return it from the trigger POST. (Client rewrites the URL — §D.)
6. **Connection budget.** Two SSE connections total per client (one durable session stream for the active session + one global status stream), staying well under the HTTP/1.1 6-per-origin cap and leaving room for approve/deny POSTs.

### C. Shared schema (`@dorkos/shared`)

Add `SessionEvent` (discriminated union with `seq`), `SessionSnapshot`, `SessionListEvent`, `SessionStatus` (context usage, token/cost/cache, model, permission mode, todo counts, running-subagent count) Zod schemas under a new `/session-stream` subpath. Retain `remainingMs` on interaction events (ADR-0262). All new fields validated with Zod; DTOs reuse per-type fields.

### D. Client — StreamManager, store, hydration (`apps/client/src/`)

1. **`StreamManager` module-level singleton** (`layers/shared/lib/transport/` or `layers/entities/session/model/`, per `research/20260328` + `20260327_sse_singleton_strictmode_hmr`): owns the durable session SSE and the global status SSE across route changes, StrictMode double-mount, and session switches (HMR-safe via `import.meta.hot.data`). Dispatches `SessionEvent`s into a Zustand **`Record<sessionId, SessionState>`** store; React reads via `useSyncExternalStore`. This removes the `initSession()`-resets-`currentParts` orphaning and the per-component stream lifecycle.
2. **Hydration protocol (subscribe-first).** On opening a session: open the durable SSE first (record its `stream_ready` cursor), apply the snapshot it sends, replay the gap, then go live — idempotent by `seq`. TanStack Query's history query is retained only as the snapshot source for completed turns where useful; the durable stream is the live mechanism. Status items read from `SessionState.status` (hydrated by the snapshot) so context usage etc. are populated immediately on refresh/switch.
3. **Compose-next queue scoping (DOR-81).** Move the queue out of component-local `useState` into the per-session store keyed by `sessionId`; pin flush to the origin session (`queueSessionRef`) and bail if `sessionId !== queueSessionRef.current`; reset `prevStatusRef` on session change. Add `key={sessionId}` to `ChatPanel` (or equivalent) so session-scoped state cannot leak. Defense-in-depth assert in the submit path.
4. **Canonical id URL rewrite (DOR-74).** When the trigger POST returns the canonical id, `router.replace` the URL `?session=` to it (no history entry). URLs become stable and shareable; one canonical id thereafter.
5. **Sidebar + status from the global stream.** `use-sessions` and `ChatStatusSection` subscribe to the store fed by `/api/events`; remove the 5s `['sessions']` poll. List is accurate after refresh (snapshot on connect) and live.

### E. Feature flags

- **Remove "Multi-window sync"** (`enableCrossClientSync`) — cross-client live sync is now the always-on default. Delete the flag, its store field, the `syncUrl` gate, and the Advanced toggle.
- **Keep "Background refresh"** (`enableMessagePolling`) **defaulting OFF, re-described.** Its real purpose is picking up sessions/turns driven **outside** DorkOS (e.g. the Claude Code CLI). Primary coverage for external sessions is now server-side discovery via `subscribeSessionList` → `/api/events` (always on). This toggle becomes an **opt-in client-side polling fallback** for environments where server-side file-watching is unreliable (network filesystems, certain platforms) or where a user wants belt-and-suspenders refresh. New copy (approx.): _"Poll for updates to sessions running outside DorkOS (e.g. the Claude Code CLI). Off by default — DorkOS already detects external sessions automatically; enable this only if external activity isn't appearing promptly."_

### F. Stateless runtime proof (stub adapter)

Extend the existing **test-mode runtime** (`apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts`) into a **stateless, DorkOS-log-backed** adapter that stores no native transcript: it implements `getSessionSnapshot`/`subscribeSession`/`subscribeSessionList` purely against the DorkOS-owned EventLog (the server persists the events it already buffers). This exercises the non-JSONL path end-to-end — proving the contract has no baked-in JSONL/file assumptions — without integrating a real second runtime.

### Why this shape

The server is the only always-present process and already receives every runtime event, so it is the correct durable mediator regardless of runtime persistence. Decoupling the turn from the POST and exposing one resumable per-session stream is the canonical snapshot+resumable-delta pattern (Linear sync engine, Vercel/Upstash resumable streams, Ably resume tokens) right-sized for self-hosted single-user (in-process buffer, no Redis). Owning the _contract_ but delegating _persistence_ ("own the boundary, not the bytes") avoids double-writing Claude's transcripts while guaranteeing stateless runtimes work. Making correctness always-on — never flag-gated — is the root-cause fix for the reported symptoms.

## User Experience

- Open a session URL or hard-refresh mid-turn → the conversation hydrates instantly to current state and the in-flight response keeps streaming as if uninterrupted; the status bar shows the correct context usage/model immediately.
- Switch between concurrently-working sessions → each loads instantly from the store and continues streaming; a queued ("compose next") message always goes to the session it was composed in.
- The sidebar reflects accurate agent/session state immediately after a refresh and updates live — including sessions started from the Claude Code CLI — without a visible poll lag.
- After a server restart mid-turn, the conversation hydrates to the last completed state and clearly indicates the interrupted turn rather than showing a frozen "Thinking…".

## Testing Strategy

- **Shared/contract unit tests:** `SessionEvent`/`SessionSnapshot` Zod schemas; idempotent apply (`seq <= lastAppliedSeq` is a no-op); cursor monotonicity. _(Guarantees gap-free, dup-free reconciliation.)_
- **Server unit/integration** (`services/session/__tests__`, `routes/__tests__/sessions-events.test.ts`):
  - Projector: assigns seq, projects status/pending/todos, ring-buffer retains current turn + TTL eviction.
  - `GET /:id/events`: cold connect sends snapshot then live; reconnect with `Last-Event-ID` replays only the gap from the buffer and does **not** resend the snapshot; expired interactions excluded. _(The core resumability guarantee.)_
  - `GET /events`: emits `session_upserted`/`agent_status` for a session created/updated **outside** DorkOS (simulate an external JSONL write) without client polling. _(External-session liveness.)_
  - Trigger POST returns canonical id; turn delivered only via the durable stream (no double-delivery). _(Migration safety.)_
  - **Stub adapter** drives the full snapshot/subscribe/list contract with **no native store**, proving runtime-agnosticism. _(Decision 1 end-to-end.)_
- **Client** (`stream-manager.test.ts`, `session-store.test.ts`, `use-session-*.test.tsx`):
  - StreamManager survives session switch + StrictMode double-mount without dropping or duplicating the connection; applies events idempotently by seq.
  - Hydration: snapshot populates messages + status (context usage non-null on cold mount); gap replay + live with no dupes.
  - Compose-next queue is pinned to its origin session and never flushes to the switched-to session. _(DOR-81 regression.)_
  - Canonical-id URL rewrite occurs once and is stable thereafter. _(DOR-74.)_
- **Browser acceptance** — `/chat:session-switch-test` matrix green, including the DOR-77 `perm:bypassPermissions` checks (#2–#5: subagents, queue drain, todos) and a new case: **hard-refresh mid-turn continues streaming**. Update the harness to assert refresh-resumability and remove the prior known-regression notes.
- Every test carries a purpose comment and targets a real failure mode (gap race, dup delivery, wrong-session queue flush, expiry boundary, server-restart degradation), not always-pass assertions.

## Performance Considerations

- Two SSE connections per client total (active-session + global), replacing N per-session connections and two timer polls. Ring buffer is bounded (e.g. ≤200 events/session, TTL ~10 min post-turn). Snapshot reads an in-memory projection (+ one history read for completed turns). Global status stream emits only on lifecycle transitions, not on a timer.
- Server-side directory watch for external-session discovery is bounded by the number of project dirs; debounce file events. The opt-in client polling fallback, when enabled, uses the existing adaptive interval.

## Security Considerations

- Recovery/streaming only ever **reads** state; the sole mutations remain the authenticated approve/deny/respond and trigger-POST routes (single-resolve, id-keyed, stale-click-safe per ADR-0262). Exposing a snapshot cannot run a tool.
- `seq`, `startedAt`, and `remainingMs` are server-assigned; a reconnecting client cannot extend a deadline or forge ordering.
- The MCP/external surface is unchanged; the new SSE routes follow existing auth on the API.

## Documentation

- `/api/docs` entries for `GET /api/sessions/:id/events` and `GET /api/events`; deprecate/replace `GET /api/sessions/:id/stream`.
- New/updated `contributing/` guide on the session-streaming architecture (snapshot + resumable delta, the runtime-neutral contract, StreamManager) and how a new runtime adapter implements `getSessionSnapshot`/`subscribeSession`/`subscribeSessionList`.
- Update `AGENTS.md` "Sessions" section — sessions no longer "derive entirely from SDK JSONL files"; DorkOS owns the snapshot/event contract with pluggable per-adapter persistence.
- Update the "Background refresh" toggle copy; document removal of "Multi-window sync".
- Update `/chat:session-switch-test` expectations (refresh-resumability; DOR-77 checks).

## Implementation Phases

- **Phase 1 — Contract + projector (server, no client change).** Add `SessionEvent`/`SessionSnapshot`/`SessionListEvent` schemas; `getSessionSnapshot`/`subscribeSession`/`subscribeSessionList` on `AgentRuntime`; `SessionStateProjector` (absorbing the DOR-73 pending map) + EventLog + RingBuffer; Claude adapter maps file-watch + its in-band SDK query into the contract. Server tests green.
- **Phase 2 — Durable per-session stream + turn decouple.** `GET /:id/events` (snapshot→replay→live, always-on, `id:`/`Last-Event-ID`); make the message POST trigger-only; ensure single delivery path. Retire the `enableCrossClientSync` gate. Subsumes DOR-73 Path A/B.
- **Phase 3 — Client StreamManager + per-session store.** Module singleton owning both SSE connections; Zustand `Record<sessionId,SessionState>`; subscribe-first hydration; status items read from snapshot. Fixes `currentParts` orphaning. Remove the "Multi-window sync" toggle.
- **Phase 4 — Global status stream + sidebar/status liveness.** `GET /events`; sidebar + status subscribe; remove the 5s sessions poll; re-describe + keep "Background refresh" as opt-in external-session polling fallback (default off). Requirements #3/#4.
- **Phase 5 — DOR-74 canonical id + DOR-81 queue scoping.** Resolve+rewrite URL to canonical id; queue pinned to origin session + `key={sessionId}`.
- **Phase 6 — Stateless stub adapter + acceptance.** Extend test-mode runtime into a stateless, DorkOS-log-backed adapter exercising the full contract; run `/chat:session-switch-test` (incl. DOR-77 checks + mid-turn-refresh case); flip harness notes; finalize docs + ADRs.

## Open Questions

None — the four architectural decisions were resolved in ideation (`01-ideation.md` §6) and the three spec-level decisions (toggle fate, canonical-id strategy, runtime-store scope) were resolved during spec creation:

- **Toggles:** remove "Multi-window sync" (always-on); keep "Background refresh" default-off, re-described as an opt-in fallback for externally-driven sessions (server-side discovery is primary).
- **Session id (DOR-74):** resolve client UUID → canonical id and rewrite the URL once at first message.
- **Runtime-store scope:** design the contract + Claude adapter now **and** prove the stateless path now via a DorkOS-log-backed stub adapter.

## Related ADRs

- **Extends/generalizes ADR-0262** — Recover Pending Interactions via Hybrid Pull + SSE Re-emit (this spec collapses Path A/B into snapshot+replay for all event classes).
- **Extends ADR-0117** — Direct SSE as sole web client transport.
- Candidate new ADRs (auto-extracted, draft): server-owned durable resumable per-session stream; runtime-neutral session snapshot/event contract with pluggable persistence; global multiplexed status stream; always-on hydration (remove the Multi-window-sync gate); canonical session id via resolve+rewrite; client StreamManager singleton owning SSE across the React lifecycle.

## References

- Ideation: `specs/chat-stream-reconnection/01-ideation.md`.
- Linear: project **Chat Session Reliability**; folds in DOR-74, DOR-81; unblocks DOR-77; trivializes DOR-75, DOR-76. Generalizes DOR-73 (spec #254).
- Prior art: `specs/permission-prompt-survives-session-switch` (#254), `specs/session-state-manager` (#190), `specs/cross-client-session-sync` (#25), `specs/chat-streaming-session-reliability` (#93), `specs/tool-approval-timeout-visibility` (#138).
- Research: `research/20260328_session_state_manager_architecture.md`, `research/20260327_sse_multiplexing_unified_stream.md`, `research/20260327_sse_singleton_strictmode_hmr.md`, `research/20260306_sse_relay_delivery_race_conditions.md`, `research/20260324_sse_resilience_production_patterns.md`, `research/20260319_streaming_message_integrity_patterns.md`, `research/20260327_fetch_sse_transport_migration.md`.
- Key source refs: `apps/client/src/layers/features/chat/model/use-session-history.ts:99,157`, `apps/client/src/layers/shared/model/app-store/app-store-helpers.ts:85-86`, `apps/server/src/routes/sessions.ts`, `apps/server/src/services/runtimes/claude-code/sessions/{transcript-reader,session-broadcaster}.ts`, `packages/shared/src/{agent-runtime.ts:344,transport.ts}`, `packages/mesh/src/discovery/unified-scanner.ts`.

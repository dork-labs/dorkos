---
slug: chat-stream-reconnection
number: 255
created: 2026-06-10
status: ideation
---

# Runtime-Agnostic Session Hydration & Resumable Streaming

**Slug:** chat-stream-reconnection
**Author:** Claude Code
**Date:** 2026-06-10
**Branch:** preflight/chat-stream-reconnection

---

## 1) Intent & Assumptions

- **Task brief:** When the client loads, hard-refreshes, or switches sessions, it must (1) hydrate the _accurate current state_ of any in-progress streaming session and continue streaming, (2) load + continue streaming when navigating between sessions, (3) keep the left-sidebar agent/session list accurate after refresh and live-updating, and (4) reload status items (context usage, etc.) on refresh and switch. The user suspects something is fundamentally wrong with how the client connects/reconnects to server streams. **This is confirmed — see §4.**

- **Cross-cutting constraint (added during ideation):** The solution must be **runtime-agnostic** — it must work with the current Claude Code runtime _and_ future runtimes (OpenCode, Codex, etc.), **whether or not the runtime runs in a persistent mode**, and regardless of whether the runtime stores session history as JSONL, in another format, or not at all.

- **Assumptions:**
  - The DorkOS **Express server is the persistent process** and is the right place to be the durable mediation layer. (The _runtime_ may be persistent or per-turn; the _server_ is always up while the app runs.)
  - Single-user / single-server / self-hosted is the target deployment. No Redis/multi-instance requirement is introduced (in-process buffering is acceptable; server-restart loss of in-flight turns is an accepted boundary, consistent with ADR-0262).
  - SSE (not WebSocket) remains the transport. The research confirms SSE + the patterns below is correct for server→client streaming; WebSocket is unneeded bidirectional complexity.
  - The `Transport` interface + `AgentRuntime` interface remain the abstraction seams (hexagonal architecture). New capabilities are added at those boundaries, not bolted onto the Claude Code runtime.

- **Out of scope:**
  - Redis-backed cross-restart stream durability and multi-server fan-out (deferred; revisit if DorkOS goes hosted/multi-user).
  - Migrating to WebSocket.
  - The Obsidian `DirectTransport` in-process path beyond ensuring the new contract is implementable there (it has no SSE; it calls services directly).
  - DOR-75 (sidebar title disambiguation) and DOR-76 (task-count flicker) as standalone work — this spec makes them trivial follow-ons but does not own their final polish.
  - DOR-80 (Radix rename focus bug) — unrelated.

---

## 2) Pre-reading Log

- `decisions/0262-recover-pending-interactions-hybrid-pull-sse-reemit.md`: DOR-73's hybrid **pull (Path A) + SSE re-emit (Path B)** recovery for pending interactions, idempotent by interaction id. The template to generalize — but scoped only to approvals/questions/elicitations and held in server memory.
- `specs/permission-prompt-survives-session-switch/02-specification.md`: Full DOR-73 spec; confirms transient in-memory control events with no replay were the failure class.
- `apps/client/src/layers/features/chat/model/use-session-history.ts`: **The smoking gun.** `syncUrl` is gated on `enableCrossClientSync` (`:157`); `refetchInterval` is gated on `enableMessagePolling` (`:99`). Both default off.
- `apps/client/src/layers/shared/model/app-store/app-store-helpers.ts:85-86`: `enableCrossClientSync` and `enableMessagePolling` **both default `false`**.
- `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx:64,71`: those flags surface as **"Multi-window sync"** and **"Background refresh"** toggles.
- `apps/server/src/routes/sessions.ts`: SSE stream endpoint (`:567`), `pending-interactions` pull (`:166`), `messages` history (`:129` → `runtime.getMessageHistory` at `:153`).
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts:357`: `getMessageHistory` reads Claude Code JSONL via `transcript-reader.ts`.
- `apps/server/src/services/runtimes/claude-code/sessions/{transcript-reader,session-broadcaster}.ts`: history + live deltas are **file-watch on JSONL** — Claude-Code-specific.
- `packages/shared/src/agent-runtime.ts:344`: `getMessageHistory(projectDir, sessionId)` — the existing (insufficient) runtime seam.
- `apps/client/src/layers/features/chat/model/use-pending-interactions.ts`: Path A pull; runs **independently of the sync flag** (why DOR-73 survives refresh but nothing else does).
- `research/20260328_session_state_manager_architecture.md`, `research/20260327_sse_multiplexing_unified_stream.md`, `research/20260306_sse_relay_delivery_race_conditions.md`, `research/20260324_sse_resilience_production_patterns.md`, `research/20260319_streaming_message_integrity_patterns.md`: existing local research that pre-solves large parts of this (StreamManager singleton, multiplexed stream, subscribe-first race, Last-Event-ID buffer, snapshot+delta reconciliation).

---

## 3) Codebase Map

### Client — streaming, hydration, lifecycle

- `layers/features/chat/model/use-chat-session.ts` — top-level orchestrator. `initSession()` on mount/`sessionId` change **resets `currentParts`** (intentional for cold load; orphans in-progress UI on switch). Reads `enableCrossClientSync` / `enableMessagePolling` from the app store and threads them down.
- `layers/features/chat/model/use-session-history.ts` — history `useQuery` (`['messages', sessionId, cwd]`), history-seed effects, the **sync SSE subscription (flag-gated)**, presence, Path B routing.
- `layers/features/chat/model/use-pending-interactions.ts` — Path A pull (`['pending-interactions', …]`), `dtoToStreamEvent()`, the idempotent renderer; returns `replayInteractionEvent` for Path B.
- `layers/shared/lib/transport/sse-connection.ts` + `layers/shared/model/use-sse-connection.ts` — fetch-based EventSource replacement: backoff w/ jitter, heartbeat watchdog (45s), visibility optimization, **`Last-Event-ID` header support present but message replay never wired**.
- `layers/entities/session/model/session-chat-store.ts` — Zustand per-session state; `initSession()` resets parts. Persists state across switch for instant resume, but **cleared on hard refresh**.
- The **actual live token stream rides in-band on the POST** `/api/sessions/:id/messages` response — coupled to that request's lifecycle.

### Client — routing, sidebar, status

- `router.tsx` — `/session?session=` loader; if no param, generates a client UUID (→ DOR-74 dual-id hazard).
- `layers/entities/session/model/use-sessions.ts` + `SessionsView`/`SessionRow` — sidebar list via REST `['sessions', cwd]`, **5s poll**; no list-level SSE.
- `layers/features/chat/ui/status/ChatStatusSection.tsx` — context usage, cost, cache, usage, permission mode, model, connection. All computed from **in-memory store state**; `null` on cold load until the first live event arrives.

### Server

- `routes/sessions.ts` — `GET /:id/stream` (sync + Path B re-emit + heartbeat + file-watch), `GET /:id/pending-interactions`, `GET /:id/messages`, approve/deny/submit-answers/submit-elicitation.
- `services/runtimes/claude-code/sessions/transcript-reader.ts` — reads `~/.claude/projects/**/*.jsonl`.
- `services/runtimes/claude-code/sessions/session-broadcaster.ts` — **file-watches JSONL** to emit `sync_update`.
- `services/runtimes/claude-code/messaging/pending-interactions.ts` — in-memory pending-interaction map + `listPendingInteractions` selector (server-authoritative `remainingMs`, expiry).
- `packages/shared/src/{transport.ts,agent-runtime.ts}` — the two abstraction seams.
- Session **list** derives from `packages/mesh/src/discovery/unified-scanner.ts` (filesystem scan) — also Claude-Code/JSONL-shaped.

### Blast radius

- **Direct:** `use-session-history.ts`, `use-chat-session.ts`, `use-pending-interactions.ts`, `sse-connection.ts`/`use-sse-connection.ts`, `session-chat-store.ts`, `routes/sessions.ts`, `agent-runtime.ts`, `transport.ts`, the Claude Code runtime adapter.
- **Indirect:** `router.tsx` (DOR-74), `use-message-queue.ts`/`use-session-submit.ts` (DOR-81), `ChatStatusSection.tsx`, `use-sessions.ts`, `unified-scanner.ts`, `session-broadcaster.ts`, `ChatPanel.tsx` (likely needs `key={sessionId}` or a StreamManager decouple).
- **Tests:** `use-pending-interactions.test.tsx`, `use-chat-session-sync.test.tsx`, `sessions-interactive.test.ts`, plus new contract tests + the `/chat:session-switch-test` browser matrix.

---

## 4) Root Cause Analysis

**Repro (user's current settings: both Advanced toggles off):**

1. Send a message in session A; tokens stream (in-band on the POST). ✔ looks fine.
2. Hard-refresh mid-turn → "Thinking…" with no live tokens; status bar empty; turn only appears once written to JSONL (if at all). ✘
3. Open a second window or switch sessions → no live updates for the non-sending view. ✘
4. Sidebar/status drift and don't live-update. ✘

**Observed vs expected:** Expected always-on hydrate-to-current + continue. Observed: a one-shot history fetch on mount and then silence.

**Evidence (confirmed in code):**

- `use-session-history.ts:157` — `if (!sessionId || isStreaming || !enableCrossClientSync) return null;` ⇒ with **Multi-window sync off**, the per-session SSE `/api/sessions/:id/stream` is **never opened**. Path B re-emit, `presence`, and `sync_update` are all dead.
- `use-session-history.ts:99` — `if (!enableMessagePolling) return false;` ⇒ with **Background refresh off**, there is **no polling fallback**.
- `app-store-helpers.ts:85-86` — both flags **default `false`**.
- The live token stream is **coupled to the POST request** to `/messages`, so a refresh/second-window has nothing to reattach to.
- DOR-73 survives hard-refresh **only** because Path A pull (`use-pending-interactions.ts`) is _not_ gated on the flag; nothing else shares that property.

**Root cause (two intertwined defects):**

1. **Reconnection/hydration is a side-effect of an off-by-default feature flag, not a first-class capability.** The entire live-update + recovery path is gated behind "Multi-window sync." With it off (the user's belief that things "should just work" is therefore _wrong_ under the current design), a reconnecting client is deaf.

2. **There is no durable, reattachable per-session stream.** Live streaming is bound to the POST lifecycle, and "current state" is reconstructed only from Claude Code JSONL (history) + transient in-memory server maps (interactions/status). This is both **non-resumable** (no replay of the in-flight turn) and **runtime-coupled** (JSONL file-read + file-watch don't generalize to stateless/non-file runtimes).

**Decision:** Both defects resolve under one architecture: a **server-owned, always-on, resumable per-session stream** built on a **runtime-neutral snapshot + event-stream contract**, with the multi-window flag demoted to (at most) a presence/notification preference — never a gate on correctness.

---

## 5) Research

Full agent findings + sources retained in the discovery transcript; local cache files cited in §2. Highlights:

- **Canonical pattern — snapshot + resumable delta (subscribe-first):** open the live stream first and record its cursor, _then_ fetch the snapshot (stamped with its own cursor), replay the gap `[snapshotCursor, streamCursor]`, then go live; apply events idempotently by monotonic per-session seq. Closes both failure modes (events lost in the gap; events applied twice). This is exactly Linear's sync engine (`/sync/bootstrap` + `/sync/delta?lastSyncId=` + live `SyncAction`s).
- **SSE gap recovery:** `id:` after `data:`, browser auto-sends `Last-Event-ID` on reconnect, server replays from an in-process ring buffer; `: keepalive` + `X-Accel-Buffering: no` to defeat proxy buffering; native `EventSource` won't reconnect on 5xx (we already use fetch-based SSE, so we control this). DorkOS already has the header plumbing — only the **server replay buffer + `id:` emission** are missing.
- **Resuming an in-flight response after refresh:** Vercel `resumable-stream` (Redis Streams), Upstash consumer-groups, Ably resume tokens, LibreChat server-side turn buffering. For self-hosted single-user, an **in-process per-session ring buffer for the current turn** (TTL after `done`) is the right-sized equivalent; JSONL/own-log covers _completed_ turns, the buffer covers only the _in-progress_ turn.
- **Multiplexing sidebar liveness:** one global multiplexed status stream with named `event:` types (LaunchDarkly/GitHub pattern) beats one-SSE-per-session and beats polling. Mind the HTTP/1.1 6-connection cap — collapse to ~1–2 SSE connections total.
- **Products:** ChatGPT web _doesn't_ resume mid-stream after refresh (deliberate); Codex cloud reattaches by `task_id`; Slack catches up via `ts` cursor after reconnect. The robust ones all **decouple turn execution from the request** and **reattach by a durable key** — validating Decision 2.

**Recommendation synthesized for DorkOS:** server-owned durable stream + in-process ring buffer + global status stream + a runtime-neutral snapshot/event contract, phased. JSONL stays the _backfill_ source for completed Claude Code turns; it is **not** the live mechanism and **not** assumed for other runtimes.

---

## 6) Decisions (resolved)

| #   | Decision                                                                           | Choice                                                                               | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Who owns the source of truth for session history + live state across runtimes?** | **DorkOS owns the runtime-neutral _contract_; persistence is pluggable per adapter** | Own the boundary, not the bytes. A DorkOS-owned `getSnapshot()` + normalized event stream means server + client never branch on runtime. Adapters back it with native storage where it exists (Claude → JSONL via `getMessageHistory`, file-watch → events) and DorkOS-owned append-only log where the runtime is stateless (persist the events already buffered for the durable stream). Avoids double-writing/diverging from Claude's transcripts (honors today's "no separate store" for the runtime that storages well) while guaranteeing stateless runtimes Just Work. |
| 2   | **How is the live session stream architected?**                                    | **Server-owned durable, resumable per-session stream**                               | Decouple turn execution + token streaming from the POST. Server runs the turn, buffers events (ring buffer), exposes ONE always-on resumable SSE = snapshot + replay + live. Any client (sender, other window, refreshed tab) attaches and is correct. Subsumes DOR-73's Path A/B into one mechanism and is the root-cause fix for refresh/reconnect. **Not gated by any toggle.**                                                                                                                                                                                           |
| 3   | **How do the sidebar list + status items stay accurate and live?**                 | **Global multiplexed status stream**                                                 | Server emits agent/session status (running/idle/error, context usage, token/cost, todo counts) on one SSE the sidebar + status bar subscribe to. Accurate immediately after refresh, live without polling, runtime-agnostic (server-held projection). Replaces the 5s poll; properly fixes requirements #3 and #4.                                                                                                                                                                                                                                                           |
| 4   | **Relationship to the "Chat Session Reliability" Linear tickets.**                 | **Fold in prerequisites**                                                            | Absorb **DOR-74** (canonical session id — precondition for reliable URL/refresh hydration, req #1) and **DOR-81** (queued-message session scoping — same root cause: state not cleanly scoped on switch). This spec then **unblocks DOR-77** (the bypassPermissions verification monitor) and **trivializes DOR-75/76** (cosmetic). One coherent foundation rather than five symptom patches.                                                                                                                                                                                |

---

## 7) Proposed Architecture (for the spec to formalize)

A layered model with the server as the durable mediator:

```
 Runtime adapter            DorkOS server (persistent)                 Client
 (Claude / Codex / …)       ───────────────────────────                ──────
   native events  ─────►  SessionStateProjector (per session)
                            • in-mem live state: in-progress turn,
                              status (context/cost/cache), pending
                              interactions, todos, running subagents
                            • ring buffer (current turn, seq'd, TTL)
   native history ◄─────  Snapshot assembler:
   (getMessageHistory)       getSnapshot() = history (native OR
                             DorkOS log) + live state + cursor
                                   │
                            Durable per-session SSE  ──── id: sess-<seq> ───►  one StreamManager
                            (always-on; snapshot→replay→live)                  singleton, attaches
                                   │                                            by sessionId; idempotent
                            Global status SSE  ──── agent_status events ─────►  apply by seq → Zustand
                                                                                Record<sessionId,State>
```

**Runtime-neutral contract (new, on `AgentRuntime` + surfaced via `Transport`):**

- `getSnapshot(sessionId): SessionSnapshot` — messages (completed) + in-progress turn + status + pending interactions + cursor. Adapter decides whether history comes from native store or DorkOS log.
- `subscribe(sessionId, sinceCursor?): AsyncIterable<SessionEvent>` — normalized, seq'd events (text delta, tool, interaction, status, todo, turn-start/turn-end). Claude adapter maps file-watch + in-band turn; stateless adapter maps its per-turn process output and persists to the DorkOS log.
- Status/list projection feeds the global status stream.

**Client:** a module-level **StreamManager singleton** (per existing research `20260328_…` and `20260327_sse_singleton_…`) owns SSE connections across route/StrictMode/session changes; dispatches into a Zustand `Record<sessionId, SessionState>`; React components read via `useSyncExternalStore`. This also **fixes DOR-81** (queue/state leaves component-local `useState`) and removes the `initSession`-resets-`currentParts` orphaning.

**Feature-flag demotion:** "Multi-window sync" / "Background refresh" no longer gate correctness. Hydration + the durable stream are always on. Any remaining preference becomes presence-only (e.g., show _other_ clients' cursors) or is removed.

---

## 8) Requirements → mechanism traceability

| User req                                                    | Mechanism                                                                                         | Folds in                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------- |
| #1 URL entry / hard refresh loads current state + continues | Durable per-session SSE: `getSnapshot()` on connect + ring-buffer replay of in-flight turn + live | DOR-74 (stable canonical id in URL) |
| #2 Navigate sessions: load + continue streaming             | StreamManager attaches by `sessionId`; snapshot+live per session; queue pinned to origin session  | DOR-81                              |
| #3 Sidebar accurate after refresh + live                    | Global status stream (server-held projection), not poll/file-scan                                 | DOR-75 (titles) follow-on           |
| #4 Status items reload on refresh + switch                  | Status carried in snapshot + global status stream (context usage/cost/cache/todos)                | DOR-76 (settled counts) follow-on   |
| Cross-cutting: runtime-agnostic, persistent-or-not          | Decision 1 contract + server-as-mediator buffering                                                | —                                   |

---

## 9) Risks & open questions (for the spec phase)

- **Server-restart loss of in-flight turns** — accepted boundary (matches ADR-0262). In `pnpm dev`, hot-reload restarts abort the turn anyway; spec should degrade gracefully (snapshot from completed history, mark in-flight as interrupted) rather than show a phantom live state.
- **Snapshot/stream cursor for JSONL-backed runtimes** — JSONL lines are ordered but have no native seq; define the canonical cursor (line offset? synthetic monotonic seq assigned by the projector?) so the same contract works for file-backed and DorkOS-log-backed runtimes.
- **In-band POST vs durable stream during the transition** — sequencing the refactor so we don't double-deliver the turn (POST stream _and_ durable stream) mid-migration. Likely: durable stream becomes the single delivery path; POST becomes "enqueue/trigger turn" only.
- **DirectTransport (Obsidian)** has no SSE — the contract must be expressible as in-process async iteration there.
- **HTTP/1.1 connection budget** — collapse to ~1–2 SSE connections (durable session stream + global status stream); verify against tool-approval POSTs.
- **DOR-74 id unification** — resolve client→canonical id _before_ first message, or alias server-side, so the URL is stable across entry paths without breaking existing links.

---

## 10) Suggested phasing (non-binding; for `/ideate-to-spec`)

1. **Contract + projector (server):** `getSnapshot`/`subscribe` on `AgentRuntime`; `SessionStateProjector` + ring buffer; Claude adapter maps existing file-watch/in-band turn into it. No client change yet.
2. **Durable per-session SSE, always-on:** snapshot→replay(`Last-Event-ID`/`id:`)→live; ungate from `enableCrossClientSync`; migrate turn delivery off the POST. Subsumes Path A/B.
3. **Client StreamManager + Zustand store:** decouple streams from component lifecycle; fixes DOR-81 + `currentParts` orphaning; instant switch + refresh-safe.
4. **Global status stream:** sidebar + status items subscribe; remove the 5s poll; req #3/#4.
5. **Canonical session id (DOR-74)** + **stateless-runtime DorkOS log** (proves Decision 1 end-to-end with a non-JSONL/stateless adapter, e.g. a test-mode or Codex stub).
6. **Verification:** `/chat:session-switch-test` matrix green incl. DOR-77 checks; new contract/unit/integration tests; browser acceptance of mid-turn refresh.

---

## Next Steps

1. Review this ideation.
2. Run: `/ideate-to-spec specs/chat-stream-reconnection/01-ideation.md`
3. During spec: extract ADRs for (a) the runtime-neutral snapshot/event contract, (b) server-owned durable resumable stream, (c) global status stream — and supersede/extend ADR-0262 (DOR-73) which this generalizes.
4. Linear: link this spec to the **Chat Session Reliability** project; mark DOR-74 + DOR-81 as in-scope; note DOR-77 as unblocked-by and DOR-75/76 as trivialized-by.

# Task Breakdown: Runtime-Agnostic Session Hydration & Resumable Streaming

Generated: 2026-06-10
Source: specs/chat-stream-reconnection/02-specification.md
Last Decompose: 2026-06-10 (full mode)

## Overview

Replace DorkOS's flag-gated, POST-coupled, JSONL-only session streaming with a **server-owned, always-on, resumable per-session stream** + a **global multiplexed status stream**, both built on a **runtime-neutral session snapshot + event-stream contract** at the `AgentRuntime` boundary. The server becomes the durable mediator: it runs turns, buffers their events for replay (in-process RingBuffer), projects per-session live state (`SessionStateProjector`), and serves a gap-free `snapshot → replay → live` stream any client attaches to and is immediately correct. Correctness is never flag-gated. The contract is proven runtime-agnostic with a stateless, DorkOS-log-backed stub adapter. Folds in DOR-74 (canonical session id) and DOR-81 (queued-message session scoping); generalizes DOR-73/ADR-0262.

Backing ADRs: 0263 (runtime-neutral contract, pluggable persistence), 0264 (server-owned durable resumable stream, turn decoupled from POST), 0265 (global multiplexed status stream), 0266 (always-on hydration, remove Multi-window-sync flag), 0267 (canonical session id via resolve-and-rewrite).

**Critical path:** 1.1 → 1.2 → 1.3 → 1.4 → 2.1 → 2.2 → 3.1 → 3.2 → 3.3 → (4.1 / 5.1 / 5.2) → 6.1 → 6.2 → 6.4

---

## Phase 1: Contract + projector (server)

### Task 1.1: Add runtime-neutral session-stream Zod schemas to @dorkos/shared

**Size**: medium · **Priority**: high · **Dependencies**: none · **Can run parallel with**: —

**Technical Requirements**: New `packages/shared/src/session-stream.ts` exporting `SessionStatusSchema`/`SessionStatus`, `SessionEventSchema`/`SessionEvent` (discriminated union with integer non-negative `seq` on every member; interaction members keep `remainingMs`+`startedAt`), `SessionSnapshotSchema`/`SessionSnapshot` (`{ messages, inProgressTurn, status, pendingInteractions, cursor }`), `SessionListEventSchema`/`SessionListEvent`. Add a `./session-stream` entry to `packages/shared/package.json` exports map (mirror existing `./schemas` shape). ADR-0263; `seq` is projector-assigned, not JSONL-derived.

**Implementation Steps**: Define the four schema groups reusing `HistoryMessage`/`PendingInteractionDTO`/`PermissionMode`/StreamEvent payload shapes from `@dorkos/shared/types`; full TSDoc + module doc; wire the package export.

**Acceptance Criteria**:

- [ ] All four schemas + inferred types exported; `import ... from '@dorkos/shared/session-stream'` resolves.
- [ ] Every `SessionEvent` member has integer non-negative `seq`; interaction members keep `remainingMs`+`startedAt`.
- [ ] Tests: valid parse, invalid seq rejected, unknown `type` rejected, cursor accepts max seq.
- [ ] Tests written and passing; `pnpm lint`/`pnpm typecheck` clean.

### Task 1.2: Extend AgentRuntime + Transport with the contract methods

**Size**: medium · **Priority**: high · **Dependencies**: 1.1 · **Can run parallel with**: —

**Technical Requirements**: Add `getSessionSnapshot`/`subscribeSession`/`subscribeSessionList` to the `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`; `getMessageHistory` ~line 344 retained) and declare them on `Transport` (`packages/shared/src/transport.ts`). Add minimal compiling stubs to `TestModeRuntime` and `FakeAgentRuntime` (`@dorkos/test-utils`) so the interface change is non-breaking. ADR-0263.

**Implementation Steps**: Copy the three signatures verbatim (snapshot/subscribe/list); stub HttpTransport + DirectTransport bodies; add empty-default stubs to the two fakes.

**Acceptance Criteria**:

- [ ] Interface + Transport declare all three methods with full TSDoc; `getMessageHistory` unchanged.
- [ ] `TestModeRuntime` + `FakeAgentRuntime` compile; `pnpm typecheck` passes all packages.
- [ ] Tests written and passing (compile-level via typecheck; fakes return empty defaults).

### Task 1.3: Build SessionStateProjector with EventLog + RingBuffer

**Size**: large · **Priority**: high · **Dependencies**: 1.1, 1.2 · **Can run parallel with**: —

**Technical Requirements**: `apps/server/src/services/session/` — new `session-state-projector.ts`, `event-log.ts`, `ring-buffer.ts`; export from the `index.ts` barrel. One projector per live session: assigns per-session monotonic `seq` (projector-owned, ADR-0263), projects live state (context/cost/cache/model/mode/todos/subagents/lifecycle), appends to EventLog + bounded RingBuffer (≤200 events, TTL ~10min post-`turn_end`), absorbs the DOR-73 pending map (`messaging/pending-interactions.ts` `listPendingInteractions` semantics, expired excluded). `buildSnapshot(loadHistory)` injects the persistence source; `replayFrom(cursor)` returns seq > cursor. ADR-0264.

**Implementation Steps**: seq counter; projection updates per event type; ring TTL eviction (documented strategy); idempotency guarantee (strictly increasing seq).

**Acceptance Criteria**:

- [ ] Strictly increasing per-session seq; cursor = latest seq.
- [ ] Status/pending/todos/subagents projected; expired interactions excluded; `remainingMs` server-authoritative.
- [ ] Ring retains current turn, evicts after TTL; cap enforced via named constant.
- [ ] `replayFrom(cursor)` returns only seq > cursor.
- [ ] Tests (seq monotonicity, ring TTL, replay gap, expiry boundary) written and passing.

### Task 1.4: Implement the contract on the Claude Code adapter (JSONL-backed)

**Size**: large · **Priority**: high · **Dependencies**: 1.2, 1.3 · **Can run parallel with**: —

**Technical Requirements**: Implement the three contract methods on `claude-code-runtime.ts` (`getMessageHistory` ~line 357 retained, called by `loadHistory()`). Map `session-broadcaster.ts` file-watch + the in-band SDK query into normalized seq'd `SessionEvent`s fed to the projector; map `unified-scanner.ts` discovery + a debounced directory watch into `subscribeSessionList` (incl. external/CLI sessions). SDK imports stay inside `services/runtimes/claude-code/` (ESLint). ADR-0263.

**Implementation Steps**: snapshot via projector `buildSnapshot(loadHistory)`; subscribe yields projector stream (gap replay on `sinceCursor`); list emits on transitions only, debounced.

**Acceptance Criteria**:

- [ ] All three methods implemented; `getMessageHistory` retained.
- [ ] Snapshot = completed JSONL + live projection + correct cursor; subscribe normalizes + replays gap.
- [ ] `subscribeSessionList` surfaces an externally-written session without polling.
- [ ] Tests (snapshot from fixture JSONL, subscribe normalization, external-write discovery) written and passing; SDK-boundary ESLint rule respected.

---

## Phase 2: Durable per-session stream + turn decouple

### Task 2.1: Add durable GET /api/sessions/:id/events (snapshot → replay → live)

**Size**: large · **Priority**: high · **Dependencies**: 1.3, 1.4 · **Can run parallel with**: —

**Technical Requirements**: New always-on `GET /api/sessions/:id/events` in `apps/server/src/routes/sessions.ts` (replaces gated `/:id/stream` at ~line 567). Cold connect: emit `snapshot` then live via `subscribeSession`. Resume (`Last-Event-ID: <sid>-<seq>` header — supported by `sse-connection.ts` — or `?after=`): skip snapshot, replay gap only. Emit `id: <sid>-<seq>` per frame, `: keepalive` ~15s, `X-Accel-Buffering: no`. No flag gate (ADR-0266). Mark `/:id/stream` deprecated-pending-client-migration. ADR-0264; collapses DOR-73 Path A/B.

**Acceptance Criteria**:

- [ ] Always-on; cold connect emits snapshot then live with `id:` frames.
- [ ] Reconnect with `Last-Event-ID` replays only the gap and does NOT resend the snapshot; `?after=` identical.
- [ ] Expired interactions excluded; keepalive + `X-Accel-Buffering: no` set.
- [ ] Tests in `routes/__tests__/sessions-events.test.ts` (`collectSseEvents`/supertest + `FakeAgentRuntime`) written and passing.

### Task 2.2: Decouple turn execution from the message POST (trigger-only, single delivery)

**Size**: large · **Priority**: high · **Dependencies**: 2.1 · **Can run parallel with**: —

**Technical Requirements**: Refactor `POST /:id/messages` (~line 307) to trigger-only: validate, lock, append user message, feed `sendMessage` into the `SessionStateProjector` (turn runs server-side), return `202` + canonical `{ sessionId }`. Tokens delivered ONLY via `GET /:id/events` (single path; no double-delivery). On server restart, mark the in-flight turn `interrupted` (ADR-0262/0264 accepted loss boundary). ADR-0264.

**Acceptance Criteria**:

- [ ] POST returns `202` + canonical id quickly; no in-band token streaming.
- [ ] Turn delivered exactly once via the durable stream; lock/validation preserved.
- [ ] Restart mid-turn marks the turn `interrupted` (no phantom live state).
- [ ] Migration-safety test (single delivery path; restart degradation) written and passing.

### Task 2.3: Wire global status stream through subscribeSessionList

**Size**: medium · **Priority**: high · **Dependencies**: 1.4, 2.1 · **Can run parallel with**: 2.2

**Technical Requirements**: Connect the existing unified `GET /api/events` (`routes/events.ts` + `eventFanOut` in `services/core/event-fan-out.ts`) to `subscribeSessionList`. New `services/session/session-list-broadcaster.ts` iterating the adapter's list stream → `eventFanOut.broadcast('session_upserted'|'session_removed'|'session_status'|'agent_status'|'presence', data)`, validated against `SessionListEventSchema`. Start it after runtime registration in `index.ts` (~line 484). Emit on transitions only; always-on (ADR-0265).

**Acceptance Criteria**:

- [ ] `/api/events` carries the five event types from `subscribeSessionList`.
- [ ] External-session write yields `session_upserted` without client polling.
- [ ] Transition-only emission; payloads validated; clean startup/shutdown.
- [ ] External-session-liveness test written and passing.

---

## Phase 3: Client StreamManager + per-session store

### Task 3.1: Build StreamManager module singleton + per-session Zustand store

**Size**: large · **Priority**: high · **Dependencies**: 2.1 · **Can run parallel with**: —

**Technical Requirements**: `apps/client/src/layers/shared/lib/transport/stream-manager.ts` (FSD shared layer) owns the durable session SSE + global status SSE across route/StrictMode/session changes (HMR-safe via `import.meta.hot.data`; uses existing `sse-connection.ts`). Per-session Zustand `Record<sessionId, SessionState>` (`entities/session/model/session-stream-store.ts`) read via `useSyncExternalStore`. Idempotent apply by `seq`. Reconcile/replace the orphaning `session-chat-store.ts` `initSession()` reset — no parallel store. Two connections total (budget). Export from barrels.

**Acceptance Criteria**:

- [ ] Singleton survives session switch + StrictMode double-mount without dropping/duplicating connections.
- [ ] `attach`/`detach` re-targets the durable connection; apply idempotent by seq (dup = no-op).
- [ ] Per-session store replaces the `currentParts` orphaning; no duplicate store remains.
- [ ] Tests (`stream-manager.test.ts`, `session-stream-store.test.ts`) written and passing; no FSD violations.

### Task 3.2: Implement subscribe-first hydration; status items read from snapshot

**Size**: large · **Priority**: high · **Dependencies**: 3.1 · **Can run parallel with**: —

**Technical Requirements**: Wire subscribe-first hydration into `use-session-history.ts` (history query ~line 91 retained as snapshot source only), `use-chat-session.ts` (route hydration through StreamManager, not `initSession()` reset), and `ChatStatusSection.tsx` (read `SessionState.status`, non-null on cold mount). Protocol: open durable SSE first → record `stream_ready` cursor → apply snapshot → replay gap → live; idempotent by seq. Requirements #1, #2, #4.

**Acceptance Criteria**:

- [ ] Open/refresh hydrates messages + status and continues an in-progress turn (req #1).
- [ ] Session switch loads from the per-session store and continues streaming (req #2).
- [ ] Status bar shows context usage/model immediately on cold mount (req #4); no `currentParts` orphaning.
- [ ] Tests (snapshot populates messages+status non-null; gap replay + live no-dupes) written and passing (verify via `pnpm test -- --run`).

### Task 3.3: Remove enableCrossClientSync flag + syncUrl gate; migrate store; delete GET /:id/stream

**Size**: medium · **Priority**: high · **Dependencies**: 3.2 · **Can run parallel with**: —

**Technical Requirements**: Remove `enableCrossClientSync` from `app-store-helpers.ts` (`BOOL_KEYS`/`BOOL_DEFAULTS` ~line 85) + the app-store slice/setter/selectors + prop threading; add a one-time migration purging the stale localStorage key. Delete the `syncUrl` gate (~line 156-162) and the `/api/sessions/:id/stream` subscription in `use-session-history.ts`. Remove the "Multi-window sync" row from `AdvancedTab.tsx` (~line 63-68) and update section copy. Delete `GET /:id/stream` server-side (~line 567). ADR-0266.

**Acceptance Criteria**:

- [ ] `enableCrossClientSync` gone everywhere; migration purges stale key (absent-key = no-op, tested).
- [ ] `syncUrl` gate + `/stream` subscription removed; second-window live sync works by default via StreamManager.
- [ ] "Multi-window sync" toggle removed; `GET /:id/stream` deleted; no references remain.
- [ ] Tests (migration, updated `use-session-history`/AdvancedTab) written and passing.

---

## Phase 4: Global status stream + sidebar/status liveness

### Task 4.1: Subscribe sidebar + status to global stream; remove the 5s sessions poll

**Size**: medium · **Priority**: high · **Dependencies**: 2.3, 3.1 · **Can run parallel with**: —

**Technical Requirements**: Remove `refetchInterval: QUERY_TIMING.SESSIONS_REFETCH_MS` (~line 31) from `use-sessions.ts`; keep the query as cold-load source; drive live updates from the global status store slice (`session_upserted`/`removed`/`status` → update list via the existing `setQueryData(['sessions',...])` merge pattern ~line 16). Ensure `ChatStatusSection`/`use-chat-status-sync.ts` reflect live `agent_status`/`session_status`. ADR-0265; requirements #3/#4.

**Acceptance Criteria**:

- [ ] 5s `['sessions']` poll removed.
- [ ] Sidebar accurate after refresh + live (incl. external/CLI sessions) without polling (req #3).
- [ ] Status items reflect live status (req #4).
- [ ] Tests (`use-sessions.test.tsx`: no poll; upserted adds, removed deletes; external surfaces) written and passing.

### Task 4.2: Retain + re-describe Background refresh as opt-in external-session fallback

**Size**: small · **Priority**: medium · **Dependencies**: 3.3 · **Can run parallel with**: 4.1

**Technical Requirements**: Keep `enableMessagePolling` (default OFF, key retained); replace the "Background refresh" row copy in `AdvancedTab.tsx` (~line 70-75) with the external-session-fallback description; keep the `:99` polling gate as opt-in fallback using the adaptive interval; verify no correctness path depends on it. No `conf` migration (client persisted boolean). ADR-0266.

**Acceptance Criteria**:

- [ ] Toggle remains, defaults OFF; new description matches the spec's fallback framing; section copy updated.
- [ ] `enableMessagePolling` controls only the opt-in poll; no correctness path depends on it (grep-verified).
- [ ] AdvancedTab test (new copy + default-off) written and passing.

---

## Phase 5: Canonical id + queue scoping

### Task 5.1: Resolve client UUID to canonical session id and rewrite the URL (DOR-74)

**Size**: medium · **Priority**: high · **Dependencies**: 2.2, 3.1 · **Can run parallel with**: 5.2

**Technical Requirements**: Trigger POST resolves client UUID → runtime canonical id (reuse the remap logic formerly at ~line 377 of `sessions.ts`) and returns it in the `202` body. Client `router.replace`s `?session=` to the canonical id once (no history entry) in `router.tsx`/`use-session-submit.ts`, then re-targets StreamManager (`attach(canonicalId)`). Reject the alias-both-ids approach. ADR-0267.

**Acceptance Criteria**:

- [ ] POST returns canonical id; client rewrites URL once, stable thereafter; no extra history entry.
- [ ] StreamManager follows the canonical id; refresh/URL-entry hydrate against it (supports req #1).
- [ ] Tests (rewrite once + stable; POST returns canonical id) written and passing.

### Task 5.2: Scope the compose-next queue to its origin session and add key={sessionId} (DOR-81)

**Size**: medium · **Priority**: high · **Dependencies**: 3.1 · **Can run parallel with**: 5.1

**Technical Requirements**: Move the queue from component-local `useState` into the per-session store keyed by `sessionId` (`use-message-queue.ts`/`use-chat-queue.ts`). Pin flush to origin via `queueSessionRef`; bail if `sessionId !== queueSessionRef.current`; reset `prevStatusRef` on session change (`use-session-submit.ts`). Add `key={sessionId}` to `ChatPanel`. Defense-in-depth cross-session-flush assert.

**Acceptance Criteria**:

- [ ] Queue lives per-session in the store; always flushes to its origin session; never misdelivers on switch.
- [ ] `prevStatusRef` resets on switch; phantom streaming→idle can't auto-flush wrong session; `ChatPanel` keys on session.
- [ ] DOR-81 regression test (queue pinned to origin, never flushes to switched-to session) written and passing.

---

## Phase 6: Stateless stub adapter + acceptance

### Task 6.1: Extend test-mode runtime into a stateless DorkOS-log-backed contract adapter

**Size**: large · **Priority**: high · **Dependencies**: 1.3, 2.1, 2.3 · **Can run parallel with**: —

**Technical Requirements**: Replace the empty stubs in `test-mode-runtime.ts` with real contract implementations backed ONLY by the DorkOS EventLog (no native transcript): `getSessionSnapshot` reconstructs messages from the EventLog; `subscribeSession` yields seq'd events from the in-process turn loop (`scenarioStore`), replaying from the log on `sinceCursor`; `subscribeSessionList` emits without any filesystem watch. Keep `DORKOS_TEST_RUNTIME=true` gating. Proves ADR-0263 Decision 1 end-to-end (Design F).

**Acceptance Criteria**:

- [ ] All three methods implemented against the EventLog with no native store.
- [ ] `/api/sessions/:id/events` + `/api/events` behave identically to the Claude adapter (no runtime branching).
- [ ] Runtime-agnosticism test (full snapshot/subscribe/list with no native store) written and passing.

### Task 6.2: Run + extend /chat:session-switch-test for refresh-resumability and DOR-77 checks

**Size**: medium · **Priority**: high · **Dependencies**: 4.1, 4.2, 5.1, 5.2, 6.1 · **Can run parallel with**: —

**Technical Requirements**: Update `.claude/commands/chat/session-switch-test.md` (checks table ~line 147-156; refresh step ~line 124): add a "hard-refresh mid-turn continues streaming" check (req #1); assert the in-flight turn keeps streaming and the status bar populates immediately; remove stale known-regression notes (~line 22). Run the matrix green incl. DOR-77 `bypassPermissions` checks #2-#5. Use the `browser-testing` methodology.

**Acceptance Criteria**:

- [ ] All checks PASS incl. new hard-refresh-mid-turn case and DOR-77 #2-#5.
- [ ] Harness markdown updated (new check; stale notes removed/reframed).
- [ ] Evidence report saved under `test-results/session-switch-test/`; prior FAILs noted now-PASS.
- [ ] Requirements #1-#4 pass live under default + `bypassPermissions`; no console errors / double-delivery / wrong-session flush.

### Task 6.3: Add cross-client / multi-window scenario tests

**Size**: medium · **Priority**: medium · **Dependencies**: 6.1 · **Can run parallel with**: 6.2

**Technical Requirements**: Deterministic, CI-runnable coverage (server `collectSseEvents`/supertest; client mock `Transport`): (1) two clients on the same in-progress session both get snapshot+identical live; (2) mid-turn second client gets snapshot+replay and converges; (3) `/api/events` `session_upserted` reaches all clients; (4) connection budget = exactly two SSE; (5) replay+live overlap applies each seq once. ADR-0266/Design B.6.

**Acceptance Criteria**:

- [ ] Five scenarios covered, each with a purpose comment targeting a real failure mode.
- [ ] Pass with both Claude/Fake runtime and the stateless test-mode runtime (no branching).
- [ ] Tests written and passing (`pnpm test -- --run`).

### Task 6.4: Update docs, API docs, AGENTS.md, and finalize ADRs

**Size**: medium · **Priority**: medium · **Dependencies**: 6.2, 6.3 · **Can run parallel with**: —

**Technical Requirements**: API docs (`/api/docs`) for `GET /api/sessions/:id/events` + `GET /api/events`; remove the `/stream` entry; regenerate if applicable. New/updated `contributing/` session-streaming guide (contract, projector/buffers, StreamManager, new-adapter recipe) + `INDEX.md`; touch architecture/state-management/data-fetching guides. Update `AGENTS.md` "Sessions" section (no longer JSONL-only; always-on durable stream; `/stream` removed). Document toggle changes. Promote ADRs 0263-0267 from draft and update `decisions/manifest.json`; note ADR-0262/0117 extended.

**Acceptance Criteria**:

- [ ] API docs updated (new endpoints; `/stream` removed); regenerated if applicable.
- [ ] `contributing/` session-streaming guide + `INDEX.md` updated; `AGENTS.md` Sessions section corrected.
- [ ] Toggle copy documented; ADRs 0263-0267 promoted with manifest updated; 0262/0117 noted extended.
- [ ] `pnpm lint` clean; `docs:reconcile`/`docs:status` show no new drift.

---

## Parallelization Notes

- **Phase 1** is strictly sequential (1.1 → 1.2 → 1.3 → 1.4) — the contract underpins everything.
- **Phase 2**: 2.2 and 2.3 can run in parallel after 2.1.
- **Phase 4**: 4.1 and 4.2 can run in parallel.
- **Phase 5**: 5.1 and 5.2 can run in parallel (both depend on 3.1; 5.1 also needs 2.2).
- **Phase 6**: 6.2 and 6.3 can run in parallel after 6.1; 6.4 closes out after both.

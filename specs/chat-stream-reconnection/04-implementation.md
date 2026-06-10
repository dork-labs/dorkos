# Implementation Summary: Runtime-Agnostic Session Hydration & Resumable Streaming

**Created:** 2026-06-10
**Last Updated:** 2026-06-10
**Spec:** specs/chat-stream-reconnection/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 7 / 18 (Phases 1–2 complete — entire server side; client begins at Phase 3)
**Branch:** `feat/chat-stream-reconnection`
**Resume at:** Phase 3, task #8 (Build StreamManager singleton + per-session Zustand store)

## Tasks Completed

### Session 1 - 2026-06-10

**Phase 1 — Foundation (contract + projector + Claude adapter)** — GATE 1 PASSED ✅

- Task #1: Add runtime-neutral session-stream Zod schemas to @dorkos/shared
- Task #2: Extend AgentRuntime + Transport with the three contract methods (+ compiling stubs in all implementors)
- Task #3: Build SessionStateProjector with EventLog + RingBuffer
- Task #4: Implement the contract on the Claude Code adapter (JSONL-backed)

Gate 1 verification: `pnpm typecheck` 21/21, `pnpm lint` 0 errors, server session+claude-code suites 479 passing, shared session-stream 15 passing. Holistic code review run; 2 criticals (C1, C2) found and fixed with regression tests before proceeding.

**Phase 2 — Durable per-session stream + turn decouple + global status stream** — GATE 2 PASSED ✅

- Task #5: Add durable `GET /api/sessions/:id/events` (snapshot→replay→live; `Last-Event-ID`/`?after=`; `id: <sid>-<seq>` frames; runtime-agnostic via the AgentRuntime contract). Also fixed Phase-1 I2 via an additive `signal?: AbortSignal` on `subscribeSession`.
- Task #6: Decouple turn execution from the POST — trigger-only, returns `202 { sessionId: canonicalId }`; turn runs detached feeding the projector via `feedProjector`; single delivery path. New `services/session/trigger-turn.ts`. Wired Phase-1 I1 (`disposeProjector` + `markInterrupted` on eviction). All pre-existing POST-streaming tests converted to the new contract.
- Task #7: Wire global status stream — `services/session/session-list-broadcaster.ts` iterates `runtime.subscribeSessionList()` → `eventFanOut.broadcast` on `/api/events`; started/stopped in `index.ts`.

Gate 2 verification: full server suite 2810 passing (192 files) before the gate review; holistic review found 2 more criticals + 3 important, ALL fixed; post-fix consolidated run 1200 passing (routes + session + claude-code), `pnpm typecheck` 21/21, `pnpm lint` 0 errors, `sessions.ts` back under the 500-line rule.

Phase-2 review fixes (all with regression tests):

- **C1** — canonical-id projector orphan: a new session's turn fed the projector under the client UUID, but the 202 returns the canonical id; client re-keying `/events` to canonical hit a fresh empty projector → turn invisible. Fixed with `rekeyProjector(oldId, newId)` (moves the SAME instance, preserving identity so in-flight feeds + open subscriptions survive; ADR-0267 no-alias preserved — one key per projector), invoked in `triggerTurn` when canonical≠request.
- **C2** — errored/interrupted turn settled to `idle` (failure masked on cold hydrate). Fixed: `turn_end` now settles to a terminal lifecycle (`error`/`interrupted`) via `deriveTurnEndLifecycle(terminalReason)`.
- **I1** — same-client concurrent turns could release each other's lock. Fixed with a per-acquisition `token` (symbol) — `releaseLock` no-ops unless the token matches the current lock.
- **I2** — `sessions.ts` > 500 lines: extracted `GET /:id/events` + `parseResumeCursor` into `routes/session-events-handler.ts` (524→441 lines).
- **I3** — broadcaster `start()` not exception-safe: wrapped iterator construction in try/catch (server stays up, discovery off on failure).

## Files Modified/Created

**Source files:**

- `packages/shared/src/session-stream.ts` (new) — runtime-neutral contract: `SessionStatus`, `SessionEvent` (discriminated union, `seq` per member), `SessionSnapshot`, `SessionListEvent` + sub-schemas. `status_change` carries a deep-partial `contextUsage` (C2 fix).
- `packages/shared/src/agent-runtime.ts` (mod) — `getSessionSnapshot`/`subscribeSession`/`subscribeSessionList` on `AgentRuntime` (ctx: `SessionOpts`).
- `packages/shared/src/transport.ts` (mod) — same three, client-facing signatures (`sessionId, sinceCursor?, cwd?`).
- `packages/shared/package.json` (mod) — `./session-stream` export entry.
- `apps/server/src/services/session/session-state-projector.ts` (new) — per-session seq owner; `ingest`/`subscribe`/`buildSnapshot`/`replayFrom`/`resolveInteraction`/`markInterrupted`; `getOrCreateProjector`/`disposeProjector` registry.
- `apps/server/src/services/session/event-log.ts` (new) — append-only ordered log (cap 5000).
- `apps/server/src/services/session/ring-buffer.ts` (new) — bounded current-turn ring (cap 200, lazy TTL ~10min, no leaked timers).
- `apps/server/src/services/session/index.ts` (mod) — barrel exports.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` (mod) — three contract methods delegating to the projector; JSONL loader injected via `getMessageHistory`.
- `apps/server/src/services/runtimes/claude-code/sessions/session-event-normalizer.ts` (new) — `toRawSessionEvent`, `feedProjector` (SDK-free; the #6 turn-feed seam).
- `apps/server/src/services/runtimes/claude-code/sessions/session-list-watcher.ts` (new) — `watchSessionList`, 250ms debounce, working `.return()`.
- `apps/server/src/services/runtimes/claude-code/index.ts` (mod) — exports normalizer/watcher.
- `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts` (mod) — compiling stubs (replaced in #15).
- `apps/client/src/layers/shared/lib/transport/session-methods.ts` (mod) — HttpTransport throwing stubs (wired in #5/#7/#8/#11).
- `apps/client/src/layers/shared/lib/direct-transport.ts` (mod) — DirectTransport throwing stubs (Phase 3/6).
- `packages/test-utils/src/fake-agent-runtime.ts` (mod) — `vi.fn()` spies.
- `packages/test-utils/src/mock-factories.ts` (mod) — `createMockTransport` + `emptyAsyncIterable`.

_Phase 2:_

- `apps/server/src/routes/sessions.ts` (mod) — new `GET /:id/events` (extracted to handler), `POST /:id/messages` rewritten trigger-only (202), `/stream` marked deprecated-pending.
- `apps/server/src/routes/session-events-handler.ts` (new) — `sessionEventsHandler` + `parseResumeCursor` (extracted from sessions.ts per I2).
- `apps/server/src/services/session/trigger-turn.ts` (new) — `triggerTurn`, `DetachedTurnLifecycle`, canonical-id tap, detached error guard, token-guarded lock.
- `apps/server/src/services/session/session-list-broadcaster.ts` (new) — iterates `subscribeSessionList` → `eventFanOut`.
- `apps/server/src/services/session/session-state-projector.ts` (mod) — `rekeyProjector`, `peekProjector`, `deriveTurnEndLifecycle`, I2 abort/finally in `subscribe()`.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` (mod) — eviction → `markInterrupted`+`disposeProjector`; `signal`/`token` threading.
- `apps/server/src/services/runtimes/claude-code/sessions/session-lock.ts` (mod) — per-acquisition `token` for owner-checked release.
- `apps/server/src/index.ts` (mod) — start/stop the session-list broadcaster.
- `packages/shared/src/agent-runtime.ts` + `transport.ts` (mod) — additive `signal?`/`token?` params.
- `packages/shared/src/schemas.ts` (mod) — `SendMessageResponseSchema`.
- `apps/server/src/services/core/openapi-registry.ts` (mod) — registered `GET /:id/events`; POST is now 202.

**Test files:**

- `packages/shared/src/__tests__/session-stream.test.ts` (new, 15)
- `apps/server/src/services/session/__tests__/session-state-projector.test.ts` (new, 17 incl. C1/C2 regressions)
- `apps/server/src/services/session/__tests__/ring-buffer.test.ts` (new, 4)
- `apps/server/src/services/session/__tests__/event-log.test.ts` (new, 2)
- `apps/server/src/services/runtimes/claude-code/__tests__/session-event-normalizer.test.ts` (new, 25 incl. C2 regression)
- `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime-session-contract.test.ts` (new)
- `apps/server/src/services/runtimes/claude-code/__tests__/session-list-watcher.test.ts` (new)

_Phase 2 tests:_ `sessions-events.test.ts` (durable stream), `sessions-trigger.test.ts` (trigger-only, canonical-id, lock, error lifecycle, C1 integration), `events-status.test.ts` (global broadcaster + I3), `session-lock.test.ts` (token-guarded release / I1), plus migrated `sessions-streaming.test.ts` / `sessions.test.ts` / `sessions-multi-runtime.test.ts` and projector C1/C2 regressions.

## Known Issues

**Resolved during GATE 1 & 2** (all with regression tests): Phase-1 C1 (replayFrom gap), C2 (outputTokens clobber); Phase-1 carry-forwards I1 (projector disposal — wired into eviction) and I2 (subscribe abort — `AbortSignal`); Phase-2 C1 (canonical-id orphan — `rekeyProjector`), C2 (errored turn → terminal lifecycle), I1 (token-guarded lock), I2 (sessions.ts split), I3 (broadcaster startup try/catch).

**Still open / carry-forward:**

- **I3 (Phase 1) — `subscribeSessionList` emits `session_upserted`/`session_removed` but not `session_status`.** External per-session liveness (streaming vs idle for a CLI session no client has opened) is NOT on the global stream. **Carry to #11/#16**: sidebar-liveness requirement #3 for purely-external sessions surfaces only via `session_upserted` metadata diffs, not live status.
- **External per-session JSONL delta → projector feeding** (so an externally-driven session's `subscribeSession` streams live mid-turn) deferred to #9 (needs JSONL-delta → StreamEvent re-parse). `subscribeSessionList` discovery of external sessions IS done.
- **Client is broken on the branch until #9.** After #6, `POST /messages` returns 202 with no in-band stream; the current client still expects the in-band stream. Expected mid-implementation — the gates are unit/integration tests, not the live app. Live browser test (#16) is the final step. Do NOT `pnpm dev` and expect working chat until Phase 3 lands.
- Pre-existing: `SessionStatusSchema.partial()` injects `runningSubagentCount: 0` via `.default(0)` at the Zod-parse wire boundary; harmless (projector operates on in-memory `RawSessionEvent`s, not parse output).

**Client contract for Phase 3 (#8/#9/#13):** open `GET /events` (snapshot→replay→live) for the active session BEFORE/at POST so `turn_start` isn't missed; POST returns `202 { sessionId: canonicalId }`; on the 202, re-key the URL + `/events` subscription to the canonical id (the server already rekeyed the projector, so snapshot+replay covers any gap — no events lost). Two SSE connections total per client: the active-session `/events` + the global `/api/events`. `Transport.subscribeSession` / `getSessionSnapshot` / `subscribeSessionList` are still client-side stubs to implement.

## Implementation Notes

### Session 1

**Fixed during GATE 1 (Phase-1 review):**

- **C1** — `SessionStateProjector.replayFrom` short-circuited on a non-empty ring and never consulted the EventLog; since the ring clears on `turn_start`, resuming with a cursor predating the current turn silently dropped the prior turn's tail + `turn_end`. Fixed by merging ring+log by seq (ordered, deduped). The gap-free resumability invariant the whole spec depends on.
- **C2** — the final `session_status` lacks `outputTokens`; the normalizer coerced it to `0` and the projector's shallow status merge clobbered the real running count. Fixed by (a) normalizer emitting only present fields, (b) `status_change` carrying a deep-partial `contextUsage`, (c) projector field-wise merging `contextUsage`. The resolved `SessionSnapshot.status.contextUsage` stays a complete object.

**Architecture established:** DorkOS owns the runtime-neutral seq + projection (ADR-0263/0264); the projector is the single server-side source of truth fed by adapter-normalized `RawSessionEvent`s; persistence is injected (`buildSnapshot(loadHistory)`), so the Claude adapter stays JSONL-backed and the stateless runtime (#15) will back the same contract with the EventLog.

**Phase 2 outcome:** the server now delivers turns exactly once over a durable, resumable per-session SSE (`/events`) decoupled from the POST, plus a global discovery/status stream (`/api/events`). Both go through the `AgentRuntime` contract (no Claude special-casing), so the stateless runtime in #15 will exercise the identical route/client code path. Every server-side spec acceptance for Phases 1–2 is met and gated; four criticals surfaced by holistic review were all fixed before proceeding. **Next: Phase 3 (#8) — the client `StreamManager` singleton + per-session Zustand store, then subscribe-first hydration (#9) and flag removal (#10).**

---
slug: durable-event-log
id: 260710-025100
linearIssue: DOR-189
adr: 260710-024641
---

# Implementation Summary: Durable EventLog

**Status:** Complete
**Started:** 2026-07-10
**Last Updated:** 2026-07-10

## Session

### Session 1 - 2026-07-10 (Anvil, flow EXECUTE)

Worktree: `../dorkos-dor189`, branch `spec-durable-event-log`. Single-agent
execution (no 03-tasks.json was decomposed; the spec's Phase 1 scope was
implemented directly).

## Decisions Recorded at Build Time

- **Open question 1 (persistence seam):** the explicit
  `getOrCreateProjector(sessionId, cwd, { persist })` flag, set by the owning
  runtime — per the ideation's own recommendation (local, honest, no hidden
  lookup). Call sites proved few: three runtime read paths + the two trigger
  paths (HTTP route + embedded), which derive `persist` from the new
  `RuntimeCapabilities.logBackedHistory` flag.
- **Open question 2 (e2e dorkHome):** verified. The acceptance run boots the
  real server (`NODE_ENV=production`) against an on-disk temp `DORK_HOME`
  (never `:memory:`); the restart-simulation vitest covers the same contract
  in-process, and the conformance `durableHistory` opt proves it per runtime.

## What Was Built (spec §Detailed Design → code)

- **Schema + migration:** `packages/db/src/schema/session-events.ts`
  (`session_events`, PK `(session_id, seq)`, JSON `payload`, ISO `created_at`),
  registered in `drizzle.config.ts` + `schema/index.ts`; migration
  `packages/db/drizzle/0026_same_stature.sql`.
- **Store:** `apps/server/src/services/session/session-event-store.ts` —
  synchronous `appendTurn` (single transaction, `INSERT OR IGNORE`, in-tx trim
  to `EVENT_LOG_MAX_EVENTS`), `readAll` (seq-ordered, poisoned rows skipped),
  `maxSeq`, `trim`.
- **Projector hook:** `SessionStateProjector.enablePersistence(store)` +
  turn-capture in `ingest()` — the completed turn (turn_start … turn_end) is
  flushed once, on `turn_end`, AFTER subscribers are woken; flush failures are
  warned-and-swallowed. Hydration on first enable of an empty projector:
  `EventLog.hydrate(store.readAll(id))` + `counter = store.maxSeq(id)`.
- **Injection seam:** module-global `setSessionEventStore()` called once from
  `apps/server/src/index.ts` after `createDb()`/`runMigrations()`.
- **Policy:** `RuntimeCapabilities.logBackedHistory?: boolean` — declared
  `true` by codex/opencode/test-mode constants; claude-code omits it. The
  trigger paths (`routes/sessions.ts`, `embedded-turn-trigger.ts`) pass
  `persist: capabilities.logBackedHistory === true`; the log-backed runtimes'
  `getSessionSnapshot`/`subscribeSession` pass `{ persist: true }` directly.
- **Read path:** `services/session/log-backed-history.ts` —
  `readLogBackedHistory(sessionId)` reads the store (no live projector needed),
  falling back to the in-memory projector when no store is wired. Used by
  codex/test-mode `getMessageHistory` and opencode's native-read fallback.

## Tests Added

- `session/__tests__/session-event-store.test.ts` (7) — round-trip, isolation,
  idempotent re-flush, maxSeq, trim boundary at `EVENT_LOG_MAX_EVENTS`,
  poisoned-row degradation.
- `session/__tests__/session-state-projector-persistence.test.ts` (8) — one
  flush per turn_end, none mid-turn, degenerate turn_end skip, throwing store
  never breaks ingest, claude-code negative, hydration seq math, no re-hydrate
  over a live projector, idempotence, replay→live subscribe unchanged by
  persistence (no seq drift/dupes).
- `session/__tests__/session-durable-restart.test.ts` (3) — the executable
  acceptance criterion: dispose projector (restart analog) → history
  reconstructs from the store with stable ids; revived projector continues seq;
  non-persisted projector leaves no durable rows.
- `runtimeConformance` gains an opt-in `durableHistory` assertion; wired for
  codex, opencode, and test-mode via the shared `durable-turn-harness.ts`.
  claude-code stays exempt.

## Acceptance Evidence

Real-process restart (see PR body): production-mode server on :4313 against a
fresh on-disk `DORK_HOME`, test-mode turn "Reply with exactly: ok" → kill →
reboot same `DORK_HOME` → `GET /api/sessions/:id/messages` returns the same
2 messages (`user-1`, `assistant-1`) with identical ids and content; 4
`session_events` rows on disk.

## Known Issues / Notes

- DOR-251 (opencode session id changes across restart) is out of scope. This
  change keys durable rows by the DorkOS session id, so if that id survives,
  the opencode EventLog-fallback history survives with it; DOR-251's id drift
  is unaffected (neither fixed nor worsened) by this work.
- No backfill for sessions predating the change (no durable source) — per spec.

---
slug: durable-event-log
id: 260710-025100
created: 2026-07-09
status: specified
linearIssue: DOR-189
adr: 260710-024641
---

# Durable EventLog: stateless-runtime transcripts survive server restart

**Status:** Draft
**Author:** Quill (agent)
**Date:** 2026-07-09

## Overview

Persist the completed-turn event stream of stateless (log-backed) runtime
sessions to SQLite so their message history survives a DorkOS server restart.
Codex, OpenCode, and test-mode sessions reconstruct history from the in-process
`EventLog`; that log is memory-only, so history opens empty after a restart even
though PR #87 already made the session list, title, and preview durable. This
spec adds a durable `session_events` store, a write-through hook on the session
projector that flushes each completed turn, and lazy hydration that restores the
event stream and its `seq` continuity on the next read.

## Background / Problem Statement

`SessionStateProjector.ingest()` stamps each event `seq = ++counter`, appends it
to an in-process `EventLog` (capped at `EVENT_LOG_MAX_EVENTS = 5000`), and wakes
subscribers. For log-backed runtimes, `getMessageHistory` /
`getSessionSnapshot` reconstruct history by folding that log
(`reconstructHistoryFromEvents`). The projector registry is a module-global
`Map<string, SessionStateProjector>`; a server restart creates a fresh map, so:

- `codex-runtime.getMessageHistory` calls `peekProjector(sessionId)`, gets
  `undefined`, and returns `[]` — an **empty transcript**.
- The `seq` counter restarts at 0, so even if events were reloaded, message ids
  (`user-${turnStartSeq}` / `assistant-${turnStartSeq}`) and the resume cursor
  would no longer line up with what clients hold.

ADR-0309 already documents this as a known limitation ("past sessions are not
rediscovered after a DorkOS server restart… history reconstructs from the
EventLog"). This spec closes the history half of that gap.

The bar (from DOR-189): **start a codex/opencode session → restart the server →
the transcript history still opens** (non-empty, with the same completed turns).

## Goals

- Completed-turn history of Codex, OpenCode, and test-mode sessions survives a
  server restart and opens with the same messages it had before.
- The write path adds no per-event cost: at most one transaction per completed
  turn.
- `seq` continuity is restored on hydration so message ids stay stable and the
  snapshot cursor is coherent after restart.
- Claude-code and the existing SSE snapshot/replay contract are provably
  unaffected.
- The mechanism is one shared implementation, not duplicated per runtime.

## Non-Goals

- Persisting claude-code history (its transcript is SDK JSONL; its `EventLog` is
  only gap-replay overflow — it must not be persisted).
- Guaranteeing gap-free **live SSE resume across a restart** (a `Last-Event-ID`
  replay spanning a restart). The cold-snapshot fallback via
  `assertResumable` → `StaleResumeCursorError` remains the contract. Cross-restart
  live resume may work opportunistically once seqs are restored, but is not
  guaranteed.
- Backfilling history for sessions that ran before this ships (no durable source
  exists).
- A unified cross-runtime transcript store, global search, or transcript export.
- Persisting the in-progress (unfinished) turn across a restart — it is dead once
  the SDK stream ends.

## Technical Dependencies

- `@dorkos/db` — Drizzle ORM over `better-sqlite3` (WAL, `synchronous = NORMAL`,
  `busy_timeout = 5000`, FK on) via `createDb()`; migrations via
  `runMigrations()`; schema files registered in `packages/db/drizzle.config.ts`.
- `@dorkos/shared` — `SessionEvent` (`@dorkos/shared/session-stream`) and
  `HistoryMessage` (`@dorkos/shared/types`).
- `apps/server/src/services/session/` — `SessionStateProjector`, `EventLog`,
  `reconstructHistoryFromEvents`, the module-global projector registry.
- `lib/dork-home.ts` — the single source of the data dir; the `Db` is constructed
  from it at boot (no `os.homedir()`).

## Detailed Design

### Data model changes

New schema file `packages/db/src/schema/session-events.ts`:

```ts
import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

// Durable per-session completed-turn event stream for LOG-BACKED runtimes
// (codex, opencode, test-mode). Claude-code does NOT write here — its transcript
// is SDK JSONL and its in-process EventLog is only gap-replay overflow.
// One row per SessionEvent; `payload` is the full event as JSON (own the
// boundary, not the bytes — ADR-0263). `(session_id, seq)` is the natural PK and
// yields ordered reads for free. Rows are written per completed turn and trimmed
// to the newest EVENT_LOG_MAX_EVENTS per session, matching the in-memory cap so
// reconstructable depth is identical before and after a restart.
export const sessionEvents = sqliteTable(
  'session_events',
  {
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull(), // ISO 8601, schema-wide parity
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.seq] }),
    bySession: index('session_events_session_idx').on(t.sessionId, t.seq),
  })
);

export type SessionEventRow = typeof sessionEvents.$inferSelect;
export type NewSessionEventRow = typeof sessionEvents.$inferInsert;
```

Register the file in `packages/db/drizzle.config.ts`, export it from
`packages/db/src/schema/index.ts`, and generate the migration
(`pnpm --filter @dorkos/db drizzle-kit generate` → next `packages/db/drizzle/00NN_*.sql`).

`payload` stores the whole `SessionEvent` (it already embeds `seq`); the `seq`
column is duplicated out for the PK / ordered range reads / trim. No per-`type`
column — trimming and reads are by `seq`; the fold in
`reconstructHistoryFromEvents` already discriminates on `event.type`.

### New store: `SessionEventStore`

`apps/server/src/services/session/session-event-store.ts` — a thin, typed wrapper
over the table, constructed with the shared `Db`:

- `appendTurn(sessionId: string, events: SessionEvent[]): void` — insert all
  events of one completed turn in a **single transaction** (`db.transaction(...)`),
  then trim (see below). `INSERT OR IGNORE` on `(session_id, seq)` so a
  re-flush is idempotent.
- `readAll(sessionId: string): SessionEvent[]` — select rows for the session
  ordered by `seq`, `JSON.parse` each `payload`. This is the durable
  completed-history source.
- `maxSeq(sessionId: string): number` — `MAX(seq)` for the session (0 when none),
  used to restore the projector counter.
- `trim(sessionId: string, maxEvents: number): void` — delete rows for the
  session whose `seq` is below the `maxEvents`-th newest (a `DELETE … WHERE seq <
(SELECT seq … ORDER BY seq DESC LIMIT 1 OFFSET maxEvents-1)` bounded delete),
  called inside `appendTurn`'s transaction with `maxEvents = EVENT_LOG_MAX_EVENTS`.

All methods are synchronous (`better-sqlite3`), so they compose into the
projector's synchronous `ingest()` without introducing an await on the hot path.

### Projector persistence hook

`SessionStateProjector` gains an **optional** persistence collaborator, set only
for log-backed sessions:

```ts
interface ProjectorPersistence {
  store: SessionEventStore;
  sessionId: string;
}
```

- **Write (flush on turn close).** `ingest()` already tracks the in-progress turn
  (`this.inProgressTurn`). When persistence is enabled and the ingested event is a
  `turn_end`, flush that turn's events — the completed `inProgressTurn` array plus
  the `turn_end` event — via `store.appendTurn(sessionId, turnEvents)`. Flushing
  the captured turn array (not a log slice) keeps the boundary precise and avoids
  re-persisting already-trimmed events. Non-turn events ingested outside a turn
  (e.g. a bare `status_change`) are not history-bearing and are not flushed;
  `reconstructHistoryFromEvents` ignores them anyway.
- **Failure isolation.** Wrap the flush in `try/catch`; on error, log a warning
  (mirroring OpenCode's "native history read failed — serving EventLog fallback"
  degradation ethos) and continue. A persistence failure must never break live
  streaming — the turn already reached the client; only its cross-restart
  durability is lost, degrading to today's behavior.
- **Hydration (lazy, on creation).** When `getOrCreateProjector` mints a **new**
  projector for a session whose persistence is enabled, before returning it:
  1. `const events = store.readAll(sessionId)`; append them to the in-memory
     `EventLog` (a new `EventLog.hydrate(events[])` or repeated `append`, without
     re-stamping seq — the events already carry their persisted seq).
  2. `this.counter = store.maxSeq(sessionId)` so the next `ingest()` continues
     monotonically and `turn_start`-derived message ids stay stable.
     This makes `projector.replayFrom(0)` and `buildSnapshot` return the persisted
     history immediately, with a coherent cursor.

### Wiring the store into the module-global registry

The registry (`getOrCreateProjector` / `peekProjector`) is a module singleton
with no DI today. Add a boot-time injection seam:

- `setSessionEventStore(store: SessionEventStore | undefined)` in the projector
  module, called once from `apps/server/src/index.ts` after `createDb()` (the
  same place `codex_threads` / `session_metadata` stores are constructed).
- Persistence is enabled **per session** by the owning runtime. The cleanest seam:
  the runtime signals "this session is log-backed, persist it" when it first
  drives the projector. Concretely, `getOrCreateProjector(sessionId, cwd, opts?)`
  gains an optional `{ persist?: boolean }`; log-backed runtimes
  (codex/opencode/test-mode) pass `persist: true`, claude-code passes nothing.
  When `persist` is true and a store is injected, the projector is created with
  `ProjectorPersistence` and hydrated. (Alternative seam in Open Questions.)

### Read path changes

- **`getMessageHistory` (log-backed runtimes).** Replace the
  `peekProjector`-returns-`[]` path with a durable read:
  `reconstructHistoryFromEvents(store.readAll(sessionId))`. This works with **no
  live projector** (post-restart) and needs no projector minting on a history
  poll. When a projector _is_ live, its completed turns are already flushed to the
  store, so the store remains the single source for completed history (no double
  counting). The live in-progress turn is delivered separately via the snapshot.
- **`getSessionSnapshot`.** Unchanged in shape: `getOrCreateProjector` (now
  hydrating) + `buildSnapshot(() => reconstructHistoryFromEvents(projector.replayFrom(0)))`.
  After hydration, `replayFrom(0)` includes the persisted history and `cursor`
  equals the restored counter.
- **OpenCode.** Its native-history path is preferred when the session is bound;
  the `EventLog` fallback now reads through the same durable store, so an
  unbound/failed-native read survives a restart too.

### seq continuity and the SSE contract

- After hydration, `counter = maxSeq`, so `assertResumable(cursor)` behaves
  coherently: a client reconnecting with a pre-restart cursor equal to the
  restored counter resumes cleanly; a cursor below the hydrated log's replay floor
  or ahead of the counter still throws `StaleResumeCursorError` → the `/events`
  route falls back to a cold snapshot (existing behavior). No change to
  `assertResumable`, `replayFrom`, or the live-delivery loop.
- Message ids are deterministic from `turn_start` seq; restoring seq keeps them
  stable across restart, so a client's optimistic/cached messages reconcile.

## User Experience

Invisible-when-working: a user with a Codex or OpenCode session restarts the
DorkOS server (upgrade, crash, machine reboot), reopens the session, and the full
conversation history is there — not a blank pane. No new UI, setting, or action.
The only observable change is the absence of the current data-loss bug.

## Testing Strategy

- **Unit — `SessionEventStore`** (`__tests__/session-event-store.test.ts`, `:memory:` db):
  - append a turn's events → `readAll` returns them in `seq` order; `JSON.parse`
    round-trips a representative `SessionEvent` union member.
  - `appendTurn` is idempotent (re-flush of the same seqs inserts no duplicates).
  - `trim` keeps exactly the newest `EVENT_LOG_MAX_EVENTS` rows and drops older
    ones; `maxSeq` returns the highest retained seq (0 when empty).
- **Unit — projector persistence** (extend the projector tests):
  - with persistence enabled, a `turn_start … turn_end` sequence writes exactly
    one turn's rows on `turn_end` and none mid-turn.
  - a store that throws on `appendTurn` does not break `ingest` (warn + continue;
    the event still streams to subscribers).
  - hydration: construct a projector over a store pre-seeded with two completed
    turns → `replayFrom(0)` yields those events, `counter === maxSeq`, and a
    subsequent `ingest` stamps `maxSeq + 1`.
- **Integration — restart simulation** (`services/session/__tests__/`):
  - drive a projector (persistence on) through two completed turns; drop it from
    the registry (`disposeProjector`); create a **new** projector over the **same**
    store (the restart analog) → `reconstructHistoryFromEvents(store.readAll(id))`
    returns both turns with stable ids. This is the executable form of the
    acceptance criterion.
  - claude-code negative: a projector without persistence writes **zero** rows.
- **Runtime conformance.** Extend `runtimeConformance` (`@dorkos/test-utils`) with
  a durability assertion for runtimes that declare log-backed storage: after a
  completed turn, a store read reconstructs it — so codex, opencode, and test-mode
  all prove the contract, and claude-code is exempt.
- **SSE integration.** Reuse `collectDurableEvents`: assert that enabling
  persistence does not change the live snapshot→replay→live event sequence within
  a single server lifetime (no seq drift, no duplication).
- **E2E / smoke (acceptance wording).** In `apps/e2e` (test-mode runtime): start a
  session, complete a turn, restart the server process against the same
  `dorkHome`, reopen the session, assert the transcript history is non-empty and
  matches. Mirrors DOR-189's smoke test.

Each test carries a purpose comment; the store and projector tests include the
failure edges (throwing store, trim boundary, hydration seq math) that reveal real
regressions rather than always-passing shape checks.

## Performance Considerations

- **Write amplification:** one transaction per completed turn, not per event. A
  streaming turn with hundreds of `text_delta` events still costs a single batched
  insert + one bounded trim delete. WAL + `synchronous = NORMAL` (existing pragma)
  keeps commit latency low and off the client-visible path (the turn has already
  streamed before `turn_end`).
- **Read cost:** `readAll` is a single indexed range scan by `(session_id, seq)`,
  bounded by `EVENT_LOG_MAX_EVENTS` rows; the fold is O(events). History polls no
  longer mint a projector.
- **Disk:** bounded per session by the trim to `EVENT_LOG_MAX_EVENTS`; total scales
  with the number of active log-backed sessions, same order as `codex_threads`.
- **Boot:** hydration is lazy (per session, on first read), so startup does not
  scan every historical session.

## Security Considerations

- Payloads are the session's own event stream — the same data already streamed to
  that session's client; no new sensitivity class, and it lives in the existing
  `~/.dork` SQLite database under the same trust boundary as `session_metadata`
  and `codex_threads`.
- `JSON.parse` of stored payloads is over server-authored JSON (we wrote it); still
  narrow to `SessionEvent` defensively and skip a row that fails to parse rather
  than throwing the whole read (a poisoned row degrades one session's tail, not
  the server).
- No `os.homedir()`; the `Db` path derives from injected `dorkHome`.

## Documentation

- Update `contributing/` session/runtime notes (and the "history reconstructs
  from the EventLog" line context) to state that log-backed history is now durable
  across restart.
- Amend ADR-0309's known-limitation note (history now survives restart; only
  session _rediscovery_ without the durable map remains SDK-limited) — via the new
  ADR's relationship section rather than editing 0309 in place.
- A changelog fragment at implementation time (not in this docs commit).

## Implementation Phases

- **Phase 1 — MVP/core:** schema + migration; `SessionEventStore`; projector
  persistence hook (flush on `turn_end`) + lazy hydration with seq restore;
  boot-time store injection; log-backed runtimes' `getMessageHistory` reads the
  store; unit + integration + restart tests; conformance durability assertion.
- **Phase 2 — enhancements (optional):** a config knob for retention depth
  (default = `EVENT_LOG_MAX_EVENTS`); a background compaction/vacuum pass if disk
  growth warrants; opportunistic cross-restart live-resume verification.
- **Phase 3 — polish (optional):** transcript export built on the durable store;
  surfacing "history truncated to last N turns" in the UI when trim has fired.

## Open Questions

- **Per-session persistence seam.** The spec proposes a `getOrCreateProjector(…,
{ persist })` flag set by the owning runtime. An alternative is a persistence
  **policy registry** keyed by runtime type (the store consults
  `session_metadata.runtime` and enables persistence for the known log-backed
  set), which keeps the flag out of every `getOrCreateProjector` call site.
  Recommended: the explicit per-call flag (local, honest, no hidden lookup), but
  the registry variant is worth a second look during EXECUTE if call sites prove
  numerous. — _founder/executor call at build time; not blocking._
- **test-mode persistence in e2e.** Confirm the e2e harness restarts the server
  against a stable on-disk `dorkHome` (not `:memory:`) so the acceptance test
  actually exercises durability. If e2e currently uses an ephemeral db, the smoke
  test needs a persistent path fixture.

## Related ADRs

- **New:** `decisions/260710-024641-durable-session-event-store.md` — Durable
  SQLite session-event store for log-backed runtimes (this spec's decision).
- **ADR-0310** — Runtime-owned session storage; this feature refines it (shared
  mechanism, per-runtime opt-in) without introducing a unified store.
- **ADR-0309** — Codex adapter; names the restart limitation this closes.
- **ADR-0255** — Per-session runtime binding (first-write-wins), the pattern the
  store's write semantics mirror.

## References

- DOR-189 (Linear) — the originating issue and smoke-test wording.
- PR #87 — durable Codex session metadata (`codex_threads`), the durability
  pattern this mirrors.
- `apps/server/src/services/session/{event-log,event-log-history,session-state-projector}.ts`
- `packages/db/src/schema/codex.ts`, `packages/db/src/index.ts`
- Audit of 2026-07-05 (runtime-hardening batch, PRs #86/#87) — approved this as a
  follow-up.

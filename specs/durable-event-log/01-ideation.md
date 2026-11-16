---
slug: durable-event-log
id: 260710-025100
created: 2026-07-09
status: ideation
linearIssue: DOR-189
---

# Durable EventLog: stateless-runtime transcripts survive server restart

**Slug:** durable-event-log
**Author:** Quill (agent)
**Date:** 2026-07-09

---

## 1) Intent & Assumptions

- **Task brief:** Codex and OpenCode transcripts live only in the in-process
  `EventLog` (`apps/server/src/services/session/event-log.ts`) and vanish on
  server restart. PR #87 made Codex session _metadata_ durable (list, titles,
  previews rehydrate; resume works via `codex_threads`), but message _history_
  still opens **empty** after a restart. Persist the completed-turn event stream
  so a stateless-runtime session's history survives a restart.
- **Assumptions:**
  - The acceptance bar is the smoke-test wording: start a codex/opencode session
    → restart the server → the transcript history still opens (non-empty).
  - Storage stays **runtime-owned** per ADR-0310; this feature adds durability to
    the shared log-backed transcript mechanism, not a new unified transcript
    store.
  - History semantics are unchanged: only **completed** turns (those closed by a
    `turn_end`) appear in reconstructed history; an in-flight turn is lost on
    restart by design because its SDK stream is dead anyway.
  - SQLite via `@dorkos/db` (Drizzle, WAL, `better-sqlite3`) is the persistence
    substrate — the same one `codex_threads` and `session_metadata` already use.
  - `dorkHome` is injected; `os.homedir()` is banned in server code.
- **Out of scope:**
  - Persisting **claude-code** history — its transcript is SDK JSONL on disk; its
    `EventLog` is only a gap-replay overflow buffer and must NOT be double-persisted.
  - Guaranteeing gap-free **live SSE resume** across a restart (Last-Event-ID
    replay spanning a restart). The cold-snapshot fallback remains the contract;
    cross-restart live resume is at most a best-effort bonus, never a guarantee.
  - Backfilling history for sessions that ran before this ships (no source to
    backfill from — they were in-memory only).
  - A cross-runtime unified transcript store, global search, or export.

## 2) Pre-reading Log

- `apps/server/src/services/session/event-log.ts`: the in-process
  append-only, length-capped (`EVENT_LOG_MAX_EVENTS = 5000`) log. Pure in-memory;
  nothing persists it. This is the thing that vanishes.
- `apps/server/src/services/session/session-state-projector.ts`: owns the
  `EventLog` + `RingBuffer`, the per-session monotonic `seq` counter, and the
  snapshot/replay/subscribe contract. `ingest()` stamps `seq = ++counter`,
  appends to log + ring, wakes subscribers. `buildSnapshot(loadHistory)` composes
  completed messages (from the injected loader) + `inProgressTurn` + status +
  `cursor: counter`. `assertResumable()` throws `StaleResumeCursorError` when a
  resume cursor is ahead of the counter (seq space reset by a restart) or below
  the log's replay floor → the `/events` route falls back to a cold snapshot.
  The projector registry is a **module-global** `Map<string, SessionStateProjector>`
  reached via `getOrCreateProjector(sessionId, cwd)` / `peekProjector(sessionId)`
  — no dependency injection today.
- `apps/server/src/services/session/event-log-history.ts`:
  `reconstructHistoryFromEvents(events)` folds the event stream into
  `HistoryMessage[]`, emitting one assistant message per turn **only on
  `turn_end`**. Message ids are derived from the turn's `turn_start` seq
  (`user-${seq}`, `assistant-${seq}`) — so **stable ids require stable seqs**
  across restart.
- `apps/server/src/services/runtimes/codex/codex-runtime.ts`:
  `getMessageHistory` uses `peekProjector` (returns `[]` when no projector) →
  after restart there is no projector → **empty history** (the bug).
  `getSessionSnapshot` uses `getOrCreateProjector` + `reconstructHistoryFromEvents(projector.replayFrom(0))`.
- `apps/server/src/services/runtimes/opencode/opencode-runtime.ts`: reads native
  history when bound; falls back to the `EventLog` when native read fails or the
  session was never bound — same in-memory fragility.
- `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts`: same
  log-backed history pattern; the conformance and e2e vehicle.
- `apps/server/src/services/runtimes/codex/thread-map.ts` +
  `packages/db/src/schema/codex.ts`: the PR #87 pattern — a dedicated
  `codex_threads` table, INSERT-OR-IGNORE first-write-wins for the immutable
  binding, write-through mutable display metadata, `listAll()` for startup
  hydration. `session_metadata` left untouched. This is the template to mirror.
- `packages/db/src/index.ts`: `createDb()` (WAL, `synchronous = NORMAL`,
  `busy_timeout = 5000`, FK on), `runMigrations()`, `Db` type, re-exported
  drizzle helpers. `packages/db/drizzle.config.ts` lists each schema file;
  migrations are generated into `packages/db/drizzle/` (latest `0025`).
- `decisions/0310-runtime-owned-session-storage-aggregated-listing.md`: storage
  is runtime-owned; the shared layers are `session_metadata`, the
  `EventLog + SessionStateProjector`, and the SSE path. No unified store.
- `decisions/0309-codex-adapter-sdk-threads.md`: explicitly names the gap —
  "history reconstructs from the EventLog" and past sessions are "**not
  rediscovered after a DorkOS server restart**." DOR-189 closes the history half.
- `decisions/0255-...`: per-session runtime binding, first-write-wins.

## 3) Codebase Map

- **Primary components/modules:**
  - `services/session/event-log.ts` — the in-memory log (unchanged; still the hot
    in-process buffer).
  - `services/session/session-state-projector.ts` — where events are ingested and
    where a persistence hook + hydration must attach.
  - `services/session/event-log-history.ts` — the fold; consumes events, no change
    to its logic, but its **input source** gains a durable path.
  - `packages/db/src/schema/` — new `session-events.ts` schema + a generated
    migration.
  - Log-backed runtimes (`codex`, `opencode`, `test-mode`) —
    `getMessageHistory` / `getSessionSnapshot` read paths.
- **Shared dependencies:** `@dorkos/db` (Drizzle/SQLite), `@dorkos/shared`
  (`SessionEvent`, `HistoryMessage`), the module-global projector registry,
  `lib/dork-home.ts` (data dir), `apps/server/src/index.ts` (boot wiring).
- **Data flow:** runtime SDK stream → `session-event-normalizer` →
  `projector.ingest()` (stamps seq) → in-memory log/ring → **[new] durable
  session-events store on turn close** → history read reconstructs from the
  store (durable) + projector (live turn).
- **Feature flags/config:** none required for MVP; retention cap reuses the
  existing `EVENT_LOG_MAX_EVENTS` semantics. A config knob is a possible Phase 2.
- **Potential blast radius:** the hot path of **every** session event write
  (mitigated: flush at turn granularity, not per event), the snapshot/replay
  cursor contract (seq continuity), server boot (store construction + wiring),
  and the three log-backed runtimes' read paths. Claude-code and the SSE contract
  must be provably unaffected.

## 4) Root Cause Analysis

- **Repro steps:**
  1. Start a Codex (or OpenCode) session; send a message; let a turn complete.
  2. Restart the DorkOS server.
  3. Open the session. The list, title, and preview rehydrate (PR #87), but the
     message history pane is **empty**.
- **Observed vs Expected:** Observed — empty transcript after restart. Expected —
  the completed-turn history opens intact.
- **Evidence:** `codex-runtime.getMessageHistory` → `peekProjector(sessionId)`
  returns `undefined` after restart (the module-global projector `Map` is fresh),
  so it returns `[]`. The `EventLog` that held the turns was in-process memory,
  never persisted. ADR-0309 documents this as a known limitation.
- **Root-cause hypothesis:** completed-turn history for stateless runtimes has no
  durable backing store; the only copy lives in the in-process `EventLog`.
  Confidence: high (direct code trace + ADR-0309 acknowledgement).
- **Decision:** persist the completed-turn event stream to SQLite and read
  history from it, so history no longer depends on a live in-memory projector.

## 5) Research

### Potential solutions

1. **SQLite `session_events` table, flushed per completed turn (RECOMMENDED).**
   A new Drizzle table `session_events(session_id, seq, payload_json, created_at)`
   with composite PK `(session_id, seq)`. A `SessionEventStore` write-through:
   on `turn_end`, flush the just-closed turn's events in one transaction, then
   trim the session to the newest `EVENT_LOG_MAX_EVENTS` rows. History reads
   `reconstructHistoryFromEvents(store.readAll(sessionId))`; the live in-progress
   turn still comes from the projector. On projector creation, hydrate the
   in-memory log from the store and restore `counter = maxSeq` for seq continuity.
   - **Pros:** mirrors the proven `codex_threads` durability pattern and uses the
     existing `@dorkos/db` substrate; write frequency is once-per-turn (not
     per-`text_delta`), so hot-path cost is bounded; crash-consistent at turn
     granularity, which exactly matches history semantics (only completed turns
     show); DRY — one mechanism shared by every log-backed runtime; seq
     continuity restores message-id stability for free.
   - **Cons:** a new table + migration; the projector gains a persistence
     collaborator and a hydration step; the module-global registry needs a
     boot-time store injection seam.
2. **JSONL-on-disk per session, mirroring claude-code.** Append each session's
   events to `~/.dork/sessions/<id>.jsonl`.
   - **Pros:** conceptually parallel to claude-code; human-inspectable; no schema
     migration.
   - **Cons:** re-invents durability the repo already solves with SQLite;
     per-event append is a per-write fsync/format cost on the hot path; trimming a
     JSONL file means rewrite-compaction; concurrent writers and crash-consistency
     are harder than a WAL transaction; adds a second persistence idiom to the
     session layer (against "consistency is a feature"). Rejected.
3. **Snapshot + tail hybrid: persist a periodic `HistoryMessage[]` snapshot plus a
   small tail of raw events.**
   - **Pros:** smallest read cost (history is pre-folded).
   - **Cons:** two representations to keep consistent; snapshot cadence is a new
     tuning knob; a crash between snapshot and tail loses turns or double-counts;
     more moving parts than the problem needs. The per-turn-flush of option 1
     already bounds cost without a second representation. Rejected.
4. **Persist every event synchronously, per-event, for all runtimes.**
   - **Cons:** worst hot-path amplification (hundreds of `text_delta` rows per
     turn); persists claude-code events that already live in JSONL; persists
     in-flight turns that are discarded on restart anyway. Strictly worse than
     option 1. Rejected.

### Key design tensions (carried into the spec)

- **Hot-path write cost on every event** → resolved by flushing at **turn
  granularity** (on `turn_end`), one transaction per completed turn, WAL +
  `synchronous = NORMAL` (already the pragma). No per-`text_delta` write.
- **Seq continuity across restart (the SSE contract)** → on hydration, restore
  `counter = max(persisted seq)` so new turns continue monotonically and
  `turn_start`-derived message ids stay stable. `assertResumable`'s cold-snapshot
  fallback remains the guarantee for any cursor that cannot be served.
- **Trimming / retention** → keep parity with the in-memory cap: after each flush,
  delete the session's rows beyond the newest `EVENT_LOG_MAX_EVENTS` by seq, so
  reconstructable history depth is identical before and after a restart.
- **Snapshot semantics** → completed history comes from the durable store; the
  in-progress turn and live status come from the projector. One durable source
  for completed turns (no double counting — completed turns are only ever in the
  store once flushed).
- **Hydration: on first read vs at boot** → **lazy**, on projector creation /
  history read, not an eager boot-time scan of every historical session (could be
  thousands). Matches the existing on-demand projector lifecycle.
- **Crash consistency** → a completed turn is durable once its transaction
  commits at `turn_end`; a crash mid-turn loses only the uncommitted in-flight
  turn, which is dead on restart regardless. Correct by construction.
- **Migration** → additive table; existing sessions gain durability only for
  turns taken after upgrade; no backfill (no source). Documented limitation.
- **Per-runtime scope vs session-service (ADR-0310)** → the **mechanism**
  (store + projector hook + hydration) lives in the shared session service
  because the log-backed runtimes share one transcript representation (the DorkOS
  `EventLog`); the **policy** (persist or not) is opt-in per session by the owning
  runtime. Claude-code opts out (JSONL is its store). This refines ADR-0310, not
  contradicts it — the log-backed runtime family collectively owns this storage,
  mediated by the projector.

### Recommendation

Option 1 — a SQLite `session_events` table with a `SessionEventStore`, flushed
per completed turn, lazily hydrated on projector creation with restored seq
continuity, read as the durable source for completed history while the projector
still serves the live turn. It mirrors the repo's proven `codex_threads`
durability pattern, bounds hot-path cost by flushing at turn granularity, and
keeps storage runtime-owned in the ADR-0310 sense while sharing one mechanism
across the log-backed runtimes.

## 6) Decisions

| #   | Decision                                                 | Choice                                                                                                            | Rationale                                                                                                                                            |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Persistence substrate                                    | SQLite `session_events` table via `@dorkos/db` (Drizzle)                                                          | Reuses the proven `codex_threads` / `session_metadata` idiom; WAL crash-consistency; avoids a second persistence idiom in the session layer.         |
| 2   | Write granularity on the hot path                        | Flush per **completed turn** (on `turn_end`), one transaction                                                     | Bounds write frequency to once-per-turn; matches history semantics (only completed turns show); crash-consistent where it counts.                    |
| 3   | Where persistence lives (per-runtime vs session service) | Mechanism in the shared session service (projector hook + store); policy opt-in per session by the owning runtime | Log-backed runtimes share one transcript representation; DRY beats duplicating durability across codex/opencode/test-mode; still ADR-0310-compliant. |
| 4   | claude-code                                              | Opt out — do **not** persist its EventLog                                                                         | Its transcript is SDK JSONL; the log is only gap-replay overflow. Persisting it would double-store and inflate the hot path.                         |
| 5   | Hydration timing                                         | Lazy, on projector creation / history read; restore `counter = maxSeq`                                            | Avoids an eager boot scan of every historical session; restores seq continuity and stable message ids.                                               |
| 6   | Retention                                                | Mirror `EVENT_LOG_MAX_EVENTS` (newest N rows per session), trim after each flush                                  | Identical reconstructable depth before/after restart; bounds disk per session.                                                                       |
| 7   | Cross-restart live SSE resume                            | Non-goal (best-effort bonus only); cold snapshot remains the guarantee                                            | A restart drops the SSE connection; `assertResumable` already degrades to a fresh snapshot. Not worth a hard guarantee.                              |
| 8   | Backfill of pre-existing in-memory-only sessions         | None                                                                                                              | No durable source exists to backfill from; documented as a one-time limitation.                                                                      |

Next step: **SPECIFY** — `specs/durable-event-log/02-specification.md`.

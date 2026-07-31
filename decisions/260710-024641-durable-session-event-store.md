---
id: 260710-024641
title: Durable SQLite session-event store for log-backed runtimes
status: accepted
created: 2026-07-09
spec: durable-event-log
extractedFrom: durable-event-log
superseded-by: null
---

# 260710-024641. Durable SQLite session-event store for log-backed runtimes

## Status

Accepted. **One clause is retired by**
[260731-211050](260731-211050-a-room-driven-claude-code-turn-leaves-a-record.md) (A room-driven
claude-code turn leaves a sparse record in `session_events`, never a history).

**Exactly one clause below is retired:** "the **policy** (persist or not) is opt-in per session by
the owning runtime — claude-code opts out." The related Negative bullet that restates it as a
standing invariant ("claude-code must not persist") goes with it. A claude-code session that a ROOM
drives now persists in a second mode, `'record'`, which writes only each turn's boundary and error
events and never hydrates — enough to prove a turn ran and how it ended, and not enough to be a
history. Read those two passages as history.

**Everything else here stands and is still the governing decision:** the `session_events` table and
its `(session_id, seq)` key; the turn-granular flush on `turn_end` and the per-session trim; the
hydrate-and-restore-`counter` behaviour for log-backed runtimes; completed history read from the
store rather than from a live projector; warned-and-swallowed flush failures; and the shape of the
split — the mechanism is shared session-service infrastructure, the policy belongs to the caller.
What changed is only that "the caller" is no longer the same thing as "the runtime".

## Context

Stateless (log-backed) runtimes — Codex, OpenCode, test-mode — reconstruct a
session's message history by folding the in-process `EventLog`
(`SessionStateProjector`), which is memory-only. A server restart re-creates the
projector registry empty, so `getMessageHistory` returns `[]` and the transcript
opens blank, even though PR #87 already made session metadata (list, title,
preview) durable via the `codex_threads` table. ADR-0309 documents this as a
known limitation. ADR-0310 fixed that storage is runtime-owned with no unified
transcript store, so the fix must add durability without introducing one — and
without inflating the hot path of every session event write, breaking the
snapshot/replay `seq` contract, or persisting claude-code (whose transcript is
SDK JSONL and whose `EventLog` is only gap-replay overflow).

## Decision

Add a durable `session_events` SQLite table (`@dorkos/db`, Drizzle; PK
`(session_id, seq)`, one JSON `payload` row per `SessionEvent`) with a
`SessionEventStore` wrapper. A projector persistence hook, enabled **per session
only for log-backed runtimes**, flushes each turn's events in one transaction on
`turn_end` — turn-granular writes, never per event — and trims the session to the
newest `EVENT_LOG_MAX_EVENTS` rows so reconstructable depth matches the in-memory
cap. On projector creation the store lazily hydrates the in-memory log and
restores `counter = maxSeq`, preserving `seq` continuity and the deterministic
`turn_start`-derived message ids. Completed history is read from the store
(`reconstructHistoryFromEvents(store.readAll(sessionId))`) so it no longer depends
on a live projector; the live in-progress turn still comes from the projector.
The **mechanism** lives in the shared session service (the log-backed runtimes
share one transcript representation); the **policy** (persist or not) is opt-in
per session by the owning runtime — claude-code opts out. Flush failures are
warned-and-swallowed so live streaming is never broken. Cross-restart live SSE
resume stays a non-goal: `assertResumable` → cold-snapshot remains the guarantee.

## Consequences

### Positive

- Codex/OpenCode/test-mode transcripts survive a server restart — the DOR-189
  acceptance bar ("restart → history still opens") is met.
- Reuses the proven `codex_threads` durability idiom on the existing SQLite/WAL
  substrate; no second persistence pattern enters the session layer.
- Turn-granular flush bounds hot-path cost to one transaction per completed turn,
  matching history semantics (only completed turns show) and giving crash
  consistency exactly where it counts.
- One shared mechanism instead of per-runtime duplication; restored `seq`
  continuity keeps message ids stable across restart.

### Negative

- A new table + migration, a boot-time store-injection seam into the previously
  DI-free module-global projector registry, and a per-session persistence flag on
  `getOrCreateProjector`.
- Refines ADR-0310's "runtime-owned storage" into "shared mechanism, per-runtime
  opt-in policy" — a nuance future runtime authors must understand (claude-code
  must not persist; log-backed runtimes must opt in). _(Retired in part by
  260731-211050: the opt-in is per CALLER, and a room-driven claude-code session
  persists in `'record'` mode.)_
- No backfill: sessions that ran before this ships remain history-less across a
  restart (no durable source to recover from).
- Disk grows with active log-backed sessions (bounded per session by the trim);
  turns beyond the retention cap are dropped from durable history by design.

## Relationships

- **Amends ADR-0309 (Codex adapter):** its known limitation "history
  reconstructs from the EventLog … past sessions are not rediscovered after a
  DorkOS server restart" is now half-closed — completed-turn **history**
  survives a restart via the durable `session_events` store. Only session
  _rediscovery_ beyond the durable `codex_threads` map remains SDK-limited.
- **Refines ADR-0310 (runtime-owned session storage):** the durable mechanism
  is shared session-service infrastructure; the persist-or-not **policy** stays
  per-runtime (`logBackedHistory` capability + `{ persist: true }` opt-in), so
  no unified transcript store is introduced.

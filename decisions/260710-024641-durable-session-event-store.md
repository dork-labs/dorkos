---
id: 260710-024641
title: Durable SQLite session-event store for log-backed runtimes
status: draft
created: 2026-07-09
spec: durable-event-log
extractedFrom: durable-event-log
superseded-by: null
---

# 260710-024641. Durable SQLite session-event store for log-backed runtimes

## Status

Draft (auto-extracted from spec: durable-event-log)

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
  must not persist; log-backed runtimes must opt in).
- No backfill: sessions that ran before this ships remain history-less across a
  restart (no durable source to recover from).
- Disk grows with active log-backed sessions (bounded per session by the trim);
  turns beyond the retention cap are dropped from durable history by design.

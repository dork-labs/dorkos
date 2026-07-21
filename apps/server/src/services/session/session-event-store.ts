/**
 * Durable per-session completed-turn event store for LOG-BACKED runtimes
 * (codex, opencode, test-mode) — the persistence half of DOR-189.
 *
 * A thin, synchronous (`better-sqlite3`) wrapper over the `session_events`
 * table. The session projector flushes each completed turn's events here in one
 * transaction on `turn_end` (turn-granular writes, never per `text_delta`), and
 * the log-backed runtimes reconstruct completed history from
 * {@link SessionEventStore.readAll} so it no longer depends on a live in-memory
 * projector. Rows are trimmed to the newest {@link EVENT_LOG_MAX_EVENTS} per
 * session so the durable reconstructable depth matches the in-memory
 * {@link EventLog} cap, before and after a restart.
 *
 * Claude-code never writes here — its transcript is SDK JSONL and its EventLog
 * is only gap-replay overflow (ADR-0309); persisting it would double-store and
 * inflate the hot path.
 *
 * The composition root constructs this with the consolidated Drizzle `Db`
 * handle (never a filesystem path, per `.claude/rules/dork-home.md`).
 *
 * @module services/session/session-event-store
 */
import { sessionEvents, eq, and, lt, desc, max, type Db, type SessionEventRow } from '@dorkos/db';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { logger } from '../../lib/logger.js';
import { EVENT_LOG_MAX_EVENTS } from './event-log.js';

/** The transaction handle Drizzle passes to a `db.transaction(cb)` callback. */
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Narrow a stored row's parsed payload to a {@link SessionEvent}, or null. */
function parsePayload(row: SessionEventRow): SessionEvent | null {
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    // Defensive shape check: we authored the JSON, but a poisoned row must
    // degrade one session's tail, not throw the whole read.
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { type?: unknown }).type === 'string' &&
      typeof (parsed as { seq?: unknown }).seq === 'number'
    ) {
      return parsed as SessionEvent;
    }
  } catch {
    // fall through to the warn below
  }
  logger.warn('[SessionEventStore] skipping unparseable session_events row', {
    sessionId: row.sessionId,
    seq: row.seq,
  });
  return null;
}

/**
 * Durable completed-turn event store for the log-backed runtimes. All methods
 * are synchronous so they compose into the projector's synchronous `ingest()`
 * without an await on the hot path.
 */
export class SessionEventStore {
  constructor(private readonly db: Db) {}

  /**
   * Persist one completed turn's events in a single transaction, then trim the
   * session to the newest {@link EVENT_LOG_MAX_EVENTS} rows. Each insert is
   * `INSERT OR IGNORE` on `(session_id, seq)`, so a re-flush of the same turn
   * (idempotent recovery) inserts no duplicates. Events already carry their
   * projector-stamped `seq`; the whole {@link SessionEvent} is stored as JSON
   * (it embeds `seq`), with `seq` duplicated out for the PK and ordered reads.
   *
   * The persisted seq space is deliberately SPARSE: only turn events are ever
   * flushed, while non-turn events ingested outside a turn (e.g. a bare
   * `status_change`) consume seqs in the projector but are never written.
   * Harmless — they are not history-bearing (`reconstructHistoryFromEvents`
   * ignores them) and {@link SessionEventStore.maxSeq} restores the counter
   * past any gap.
   *
   * @param sessionId - DorkOS session identifier
   * @param events - The completed turn's events (turn_start … turn_end), in seq order
   */
  appendTurn(sessionId: string, events: SessionEvent[]): void {
    if (events.length === 0) return;
    const createdAt = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const event of events) {
        tx.insert(sessionEvents)
          .values({ sessionId, seq: event.seq, payload: JSON.stringify(event), createdAt })
          .onConflictDoNothing()
          .run();
      }
      this.trimWithin(tx, sessionId, EVENT_LOG_MAX_EVENTS);
    });
  }

  /**
   * All persisted events for a session in `seq` order — the durable
   * completed-history source folded by `reconstructHistoryFromEvents`. A row
   * whose payload fails to parse is skipped (a poisoned row degrades one
   * session's tail, never throws the whole read).
   *
   * @param sessionId - DorkOS session identifier
   */
  readAll(sessionId: string): SessionEvent[] {
    const rows = this.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(sessionEvents.seq)
      .all();
    const events: SessionEvent[] = [];
    for (const row of rows) {
      const event = parsePayload(row);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /**
   * Delete every persisted row for a session — the durable half of a full
   * session teardown. Pairs with `disposeProjector` on the `/api/test/reset`
   * control path: disposing the in-memory projector alone leaves these rows, so
   * a reused id would resurrect pre-reset history straight from SQLite
   * ({@link SessionEventStore.readAll} is the log-backed history source). A
   * no-op when the session has no rows.
   *
   * @param sessionId - DorkOS session identifier
   */
  deleteSession(sessionId: string): void {
    this.db.delete(sessionEvents).where(eq(sessionEvents.sessionId, sessionId)).run();
  }

  /**
   * The highest persisted `seq` for a session, or `0` when none — restores the
   * projector's monotonic counter on hydration so the next `ingest` continues
   * where the pre-restart stream left off and `turn_start`-derived message ids
   * stay stable.
   *
   * @param sessionId - DorkOS session identifier
   */
  maxSeq(sessionId: string): number {
    const row = this.db
      .select({ value: max(sessionEvents.seq) })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .get();
    return row?.value ?? 0;
  }

  /**
   * Trim a session's rows to the newest `maxEvents` by `seq` (standalone
   * variant of the in-transaction trim). Exposed for tests and future
   * compaction passes.
   *
   * @param sessionId - DorkOS session identifier
   * @param maxEvents - Number of newest rows to retain
   */
  trim(sessionId: string, maxEvents: number): void {
    this.db.transaction((tx) => this.trimWithin(tx, sessionId, maxEvents));
  }

  /**
   * Delete a session's rows below the `maxEvents`-th newest `seq`, using the
   * supplied transaction so the trim commits atomically with its {@link
   * SessionEventStore.appendTurn}. A no-op when the session has `maxEvents` or
   * fewer rows.
   */
  private trimWithin(tx: DbTx, sessionId: string, maxEvents: number): void {
    // The seq of the `maxEvents`-th newest row is the retention floor; anything
    // strictly below it is trimmed. Absent (fewer than maxEvents rows) → nothing.
    const cutoff = tx
      .select({ seq: sessionEvents.seq })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(desc(sessionEvents.seq))
      .limit(1)
      .offset(maxEvents - 1)
      .get();
    if (cutoff === undefined) return;
    tx.delete(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), lt(sessionEvents.seq, cutoff.seq)))
      .run();
  }
}

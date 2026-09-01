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
 * Claude-code's HISTORY never comes from here — its transcript is SDK JSONL and
 * its EventLog is only gap-replay overflow (ADR 260710-024641); persisting it in full
 * would double-store and inflate the hot path.
 *
 * It writes here anyway, and what it writes is a RECORD rather than a history:
 * `'record'` mode (see `ProjectorPersistenceMode`) keeps a turn's boundaries,
 * its errors, and the permission decisions it was gated on — a small constant
 * per turn, whatever the model said, and nothing reads it as history.
 *
 * Two things wanted that record, a day apart. A room is the one surface with no
 * live client holding the session stream, so a turn that failed there used to
 * leave nothing durable at all — on 2026-07-31 an agent went quiet in a room for
 * forty-one minutes and this table held zero rows about it (DOR-784, ADR
 * 260731-211050). And a permission prompt is asked and answered entirely inside
 * DorkOS, so the `interaction_resolved` rows are the only durable trace that a
 * person was asked anything; they are what lets a reopened conversation show its
 * receipts (ADR 260801-035912). The second is why every session records, not
 * only room-driven ones.
 *
 * The composition root constructs this with the consolidated Drizzle `Db`
 * handle (never a filesystem path, per `.claude/rules/dork-home.md`).
 *
 * @module services/session/session-event-store
 */
import {
  sessionEvents,
  eq,
  and,
  lt,
  desc,
  max,
  or,
  sql,
  type Db,
  type SessionEventRow,
} from '@dorkos/db';
import {
  isBlockingInteractionEvent,
  type BlockingInteractionEventType,
  type InteractionResolvedEvent,
  type SessionEvent,
} from '@dorkos/shared/session-stream';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';
import { EVENT_LOG_MAX_EVENTS } from './replay/event-log.js';

/**
 * One ask that was raised and never resolved — what
 * {@link SessionEventStore.readUnresolvedInteractions} hands the boot sweep.
 */
export interface UnresolvedInteractionRow {
  /** The session the ask was raised in. */
  sessionId: string;
  /** The interaction id (the tool-use id, for a tool). */
  id: string;
  /** Which kind of prompt it was — a resolution cannot be read back without it. */
  kind: PendingInteractionDTO['type'];
  /** Server epoch ms the ask was raised at. */
  startedAt: number;
}

/** The prompt event types, mapped to the interaction kind each one raises. */
const ASK_KIND_BY_EVENT_TYPE: Readonly<
  Record<BlockingInteractionEventType, PendingInteractionDTO['type']>
> = {
  approval_required: 'approval',
  question_prompt: 'question',
  elicitation_prompt: 'elicitation',
};

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
   * flushed, while events ingested outside a turn (e.g. a bare `status_change`)
   * consume seqs in the projector but are never written.
   * {@link SessionEventStore.maxSeq} restores the counter past any gap.
   *
   * Harmless for every event that reaches this today, but no longer harmless by
   * CONSTRUCTION, and the difference is worth keeping in view. It used to be
   * true that nothing skipped here was history-bearing;
   * `reconstructHistoryFromEvents` now folds `compact_boundary` into a
   * `compaction` history message (DOR-1215), so an out-of-turn boundary would
   * be a durable row silently lost. Nothing emits one — `/compact` wraps its
   * boundary in a turn, and OpenCode's rides the turn it fires in — so the case
   * is unreachable rather than merely rare. If a runtime ever emits a boundary
   * between turns, this is the line that drops it.
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
   * A session's `interaction_resolved` rows only — the permission decisions,
   * without the turns around them.
   *
   * Its own read rather than a filter over {@link SessionEventStore.readAll}
   * because of WHERE it runs: every history read overlays these onto assembled
   * history, so `readAll` would materialize and JSON-parse up to
   * {@link EVENT_LOG_MAX_EVENTS} rows per reload to find the two that matter.
   * The `LIKE` is a scan of one session's rows (the `(session_id, seq)` index
   * bounds it) but it happens in SQLite over the raw text, and it hands back a
   * handful of rows instead of thousands.
   *
   * The pattern matches the serialized discriminant, which is stable because
   * this module authors the JSON itself. A row that somehow matched without
   * being a resolution is dropped by the caller, which reads its fields.
   *
   * @param sessionId - DorkOS session identifier
   */
  readInteractionResolutions(sessionId: string): SessionEvent[] {
    const rows = this.db
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          sql`${sessionEvents.payload} LIKE '%"type":"interaction_resolved"%'`
        )
      )
      .orderBy(sessionEvents.seq)
      .all();
    const events: SessionEvent[] = [];
    for (const row of rows) {
      const event = parsePayload(row);
      if (event?.type === 'interaction_resolved') events.push(event);
    }
    return events;
  }

  /**
   * Every ask whose TURN NEVER ENDED, across every session — the asks a process
   * death left with nothing to answer them (DOR-1439).
   *
   * ## Why the bound is the turn, not the missing resolution
   *
   * "A prompt row with no resolution row" is the tempting definition and it is
   * wrong on the upgrade path. `'history'` sessions (codex, opencode) have
   * ALWAYS persisted their `approval_required` rows, because that mode flushes
   * a whole turn — but a resolution arriving AFTER its own `turn_end` was
   * never persisted at all, and a late resolution is a state the projector
   * models on purpose (`event-log-history.ts`, `applyLateReceipts`). So on the
   * first boot after this ships, every legacy ask a person answered late looks
   * exactly like an ask nobody answered, and stamping it `expired` would
   * rewrite a real decision — durably, silently, and idempotently enough never
   * to be revisited.
   *
   * A turn that ended is a turn whose ask was settled, whether or not the
   * settling was written down. A turn that never ended is the only thing a
   * parked ask can leave behind. So a `turn_end` at a higher `seq` clears
   * everything raised before it, and what survives the scan is an ask whose
   * turn is genuinely gone. The same rule covers the rarer shape where the
   * PROMPT persisted and the RESOLUTION's write failed — `flushTurn` warns and
   * swallows — because that turn still reached its `turn_end`.
   *
   * ## Cost
   *
   * One scan at boot. Rows are bounded at {@link EVENT_LOG_MAX_EVENTS} PER
   * SESSION, and nothing prunes sessions, so the table grows with the number of
   * sessions this machine has ever run: measured at 80k rows / ~32MB the scan
   * takes ~155ms and closing 500 orphans another ~225ms. Linear, and paid once.
   *
   * A prompt whose resolution was trimmed away cannot appear as an orphan: the
   * trim keeps the NEWEST rows, and both the resolution and the `turn_end`
   * outrank the prompt they belong to, so the prompt goes first.
   */
  readUnresolvedInteractions(): UnresolvedInteractionRow[] {
    const rows = this.db
      .select()
      .from(sessionEvents)
      .where(
        or(
          sql`${sessionEvents.payload} LIKE '%"type":"approval_required"%'`,
          sql`${sessionEvents.payload} LIKE '%"type":"question_prompt"%'`,
          sql`${sessionEvents.payload} LIKE '%"type":"elicitation_prompt"%'`,
          sql`${sessionEvents.payload} LIKE '%"type":"interaction_resolved"%'`,
          sql`${sessionEvents.payload} LIKE '%"type":"turn_end"%'`
        )
      )
      .orderBy(sessionEvents.sessionId, sessionEvents.seq)
      .all();
    const orphans: UnresolvedInteractionRow[] = [];
    // One session at a time — the rows arrive grouped by session id, so an ask
    // is only ever compared against its OWN session's turns and answers. A
    // single shared map would let one session's `turn_end` close another
    // session's ask, since an interaction id is a tool-call id and unique
    // nowhere but its own session.
    let session: string | undefined;
    let open = new Map<string, UnresolvedInteractionRow>();
    const closeSession = (): void => {
      orphans.push(...open.values());
      open = new Map();
    };
    for (const row of rows) {
      if (row.sessionId !== session) {
        closeSession();
        session = row.sessionId;
      }
      const event = parsePayload(row);
      if (event === null) continue;
      if (event.type === 'turn_end') {
        open.clear();
        continue;
      }
      if (event.type === 'interaction_resolved') {
        open.delete(event.id);
        continue;
      }
      if (!isBlockingInteractionEvent(event)) continue;
      open.set(event.id, {
        sessionId: row.sessionId,
        id: event.id,
        kind: ASK_KIND_BY_EVENT_TYPE[event.type],
        startedAt: event.startedAt,
      });
    }
    closeSession();
    return orphans;
  }

  /**
   * Record how one interaction ended, for a caller with no projector to ingest
   * it through — which today means the boot sweep, because a projector is
   * exactly what a restart does not have.
   *
   * The `seq` comes from {@link SessionEventStore.maxSeq}, the same number a
   * projector for this session restores its own counter from, so a row written
   * here can never collide with one a later turn writes.
   *
   * @param sessionId - DorkOS session identifier.
   * @param resolution - The resolution to store, without its `seq`.
   * @returns The `seq` the row was written under.
   */
  appendResolution(sessionId: string, resolution: Omit<InteractionResolvedEvent, 'seq'>): number {
    const seq = this.maxSeq(sessionId) + 1;
    this.appendTurn(sessionId, [{ ...resolution, seq }]);
    return seq;
  }

  /**
   * Move a session's rows onto a new id, following the projector's canonical-id
   * rekey ({@link rekeyProjector}).
   *
   * Without this the rows are stranded. The FIRST rename is harmless — a brand
   * new session has flushed nothing yet — but the SDK assigns a new id on a
   * resume too, and by then the session has turns behind it. Their rows would
   * stay under the retired id while history renders under the new one, so every
   * permission decision before the rename would quietly stop existing.
   *
   * `UPDATE OR IGNORE` rather than a plain update: the primary key is
   * `(session_id, seq)`, and a target id that already holds a row at the same
   * seq would otherwise throw and take the rekey down with it. Ignoring leaves
   * that row where it is — stranded, which is what it already was — instead of
   * turning a data-shaped edge case into a broken rename. Unreachable in
   * practice: a rename target is an id the SDK has just minted.
   *
   * @param oldId - The id the rows were written under
   * @param newId - The id the session is now known by
   */
  rekeySession(oldId: string, newId: string): void {
    if (oldId === newId) return;
    this.db.run(
      sql`UPDATE OR IGNORE ${sessionEvents} SET ${sql.identifier('session_id')} = ${newId} WHERE ${sessionEvents.sessionId} = ${oldId}`
    );
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

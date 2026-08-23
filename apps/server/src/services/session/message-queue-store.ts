/**
 * The durable message queue: what somebody typed while the session was busy,
 * kept where a refresh, a second window, a failed turn, and a restart cannot
 * reach it (spec `persistent-session-runtime` §3.1).
 *
 * A thin, synchronous (`better-sqlite3`) wrapper over the `session_message_queue`
 * table, in the same shape as {@link SessionEventStore} beside it. Storage only:
 * it decides nothing about WHEN a message runs — the dispatcher does that — and
 * it never mutates a person's words.
 *
 * **Why persist at all.** ADR-0264 accepts losing an in-flight TURN when the
 * server restarts. Losing a message somebody typed and was told was accepted is
 * a different and worse promise to break; DOR-480 already established that this
 * class of loss is unacceptable, which is why the client queue carries a
 * `restore` handle today.
 *
 * **Ordering is a sparse integer, not an array index.** Positions step by
 * {@link QUEUE_POSITION_STEP}, so a reorder is an UPDATE of one row and the
 * rows either side keep the positions they had. Only when the gap a message
 * would land in has closed does {@link MessageQueueStore.move} respace the
 * whole session — rare, bounded by one session's queue, and it hands the next
 * move room again.
 *
 * @module services/session/message-queue-store
 */
import { randomUUID } from 'node:crypto';
import { sessionMessageQueue, eq, inArray, max, type Db } from '@dorkos/db';
import type { ClientContext } from '@dorkos/shared/additional-context';
import { ClientContextSchema } from '@dorkos/shared/additional-context';
import type { MessageDisposition, QueuedMessage } from '@dorkos/shared/schemas';
import type { SessionMessageQueueRow } from '@dorkos/db';
import { logger } from '../../lib/logger.js';

/**
 * The gap left between neighbouring queue positions. Wide enough that a person
 * can keep reordering the same queue without ever closing one — halving 1000
 * survives ten consecutive moves into the same gap before the fallback is
 * reached.
 */
export const QUEUE_POSITION_STEP = 1000;

/**
 * How many session ids one `DELETE ... IN (...)` may carry.
 *
 * SQLite compiles in a ceiling on bound variables (~32k) and every id spends
 * one, so a caller with more sessions than that would lose the whole delete
 * rather than part of it. 500 is far under the ceiling and still one statement
 * per 500 sessions.
 */
const DELETE_CHUNK_SIZE = 500;

/**
 * The process-wide queue, injected once from the composition root so the
 * modules that must carry a queue across a session rename — the projector's
 * rekey — can reach it without importing the dispatcher and closing a cycle.
 */
let sharedStore: MessageQueueStore | undefined;

/**
 * Inject the durable message queue, called once from `apps/server/src/index.ts`
 * after `createDb()`. Passing `undefined` clears it (test isolation).
 *
 * @param store - The shared store, or `undefined` to disable queueing.
 */
export function setMessageQueueStore(store: MessageQueueStore | undefined): void {
  sharedStore = store;
}

/** The injected durable message queue, or `undefined` when none is wired. */
export function getMessageQueueStore(): MessageQueueStore | undefined {
  return sharedStore;
}

/**
 * A stored queue row: the {@link QueuedMessage} every client sees, plus the two
 * fields that stay server-side — its ordering key and the client context
 * captured when it was accepted.
 */
export interface QueuedMessageRecord extends QueuedMessage {
  /** Sparse ordering key within the session. Never exposed on the wire. */
  position: number;
  /** The `ClientContext` captured at enqueue time; `null` when none was sent. */
  context: ClientContext | null;
}

/**
 * The wire view of a stored row: the five fields a client is told about, and
 * nothing else.
 *
 * {@link QueuedMessageRecord} EXTENDS {@link QueuedMessage}, so handing a record
 * straight to a snapshot or a `queue_update` would silently ship the ordering
 * key and the captured client context to every window. One projection, used by
 * both the snapshot and the event, so the two cannot disagree about what a
 * queued message is.
 *
 * @param record - A row as the store reads it
 */
export function toQueuedMessage(record: QueuedMessageRecord): QueuedMessage {
  const { id, content, disposition, enqueuedAt, enqueuedBy } = record;
  return { id, content, disposition, enqueuedAt, enqueuedBy };
}

/** What {@link MessageQueueStore.enqueue} needs to accept a message. */
export interface EnqueueInput {
  /** The session the message is waiting on — canonical id where one exists. */
  sessionId: string;
  /** The person's words, stored pristine. */
  content: string;
  /** The client that enqueued it, so a window can tell its own from another's. */
  clientId: string;
  /** As REQUESTED, never as applied. Absent means `queue`, the always-supported one. */
  disposition?: MessageDisposition;
  /** Client context captured at enqueue time, if the sender had any. */
  context?: ClientContext | null;
  /**
   * The message id, when the caller has already minted one and promised it to
   * somebody. Absent mints a fresh uuid here.
   */
  id?: string;
}

/**
 * Where a moved message should land: immediately before, or immediately after,
 * another message in the SAME session's queue.
 */
export type MoveTarget = { before: string } | { after: string };

/** Read a stored `context_json` cell, degrading a poisoned row to no context. */
function parseContext(row: SessionMessageQueueRow): ClientContext | null {
  if (row.contextJson === null) return null;
  try {
    const parsed = ClientContextSchema.safeParse(JSON.parse(row.contextJson));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to the warn below
  }
  // We authored the JSON, so this is unreachable in practice — but a poisoned
  // row must cost one message its context, never the whole queue read. The
  // person's words are in `content` and are not at risk either way.
  logger.warn('[MessageQueueStore] unreadable context on a queued message', {
    sessionId: row.sessionId,
    messageId: row.id,
  });
  return null;
}

/** Present a stored row as the record every caller reads. */
function toRecord(row: SessionMessageQueueRow): QueuedMessageRecord {
  return {
    id: row.id,
    content: row.content,
    disposition: row.disposition,
    enqueuedAt: row.enqueuedAt,
    enqueuedBy: row.clientId,
    position: row.position,
    context: parseContext(row),
  };
}

/**
 * Durable per-session message queue. All methods are synchronous so they
 * compose into the projector's synchronous ingest and the dispatcher's mutex
 * without an await on the hot path.
 */
export class MessageQueueStore {
  constructor(private readonly db: Db) {}

  /**
   * Accept a message onto the end of a session's queue and return it.
   *
   * The row is the acceptance: once this returns, the message survives a
   * refresh, a second window, a failed turn, and a restart.
   *
   * @param input - The message, its sender, and the disposition asked for
   */
  enqueue(input: EnqueueInput): QueuedMessageRecord {
    const row: SessionMessageQueueRow = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
      position: this.nextPosition(input.sessionId),
      content: input.content,
      disposition: input.disposition ?? 'queue',
      clientId: input.clientId,
      enqueuedAt: Date.now(),
      contextJson: input.context ? JSON.stringify(input.context) : null,
    };
    this.db.insert(sessionMessageQueue).values(row).run();
    return toRecord(row);
  }

  /**
   * A session's queue in dispatch order — head first.
   *
   * @param sessionId - The session whose queue to read
   */
  list(sessionId: string): QueuedMessageRecord[] {
    return this.rows(sessionId).map(toRecord);
  }

  /**
   * One queued message by id, or `undefined` when no such message is queued.
   *
   * @param messageId - The server-minted message id
   */
  get(messageId: string): QueuedMessageRecord | undefined {
    const row = this.row(messageId);
    return row ? toRecord(row) : undefined;
  }

  /**
   * Take one message off the queue and hand it back, or `undefined` when the
   * id is not queued (already dispatched, already removed, never existed).
   * Callers distinguish those by asking, not by guessing: an unknown id is a
   * 404 at the route and a no-op everywhere else.
   *
   * @param messageId - The server-minted message id
   */
  remove(messageId: string): QueuedMessageRecord | undefined {
    const row = this.row(messageId);
    if (!row) return undefined;
    this.db.delete(sessionMessageQueue).where(eq(sessionMessageQueue.id, messageId)).run();
    return toRecord(row);
  }

  /**
   * Replace a queued message's text, keeping its id and its place in the queue.
   * Returns the edited record, or `undefined` for an unknown id.
   *
   * @param messageId - The server-minted message id
   * @param content - The replacement text, stored pristine
   */
  updateContent(messageId: string, content: string): QueuedMessageRecord | undefined {
    const row = this.row(messageId);
    if (!row) return undefined;
    this.db
      .update(sessionMessageQueue)
      .set({ content })
      .where(eq(sessionMessageQueue.id, messageId))
      .run();
    return toRecord({ ...row, content });
  }

  /**
   * Move a queued message to sit immediately before or after another message in
   * the same session, and return it at its new position.
   *
   * Normally ONE row is written: the gap between the new neighbours is halved
   * and nothing else moves. When that gap has closed — no integer strictly
   * between them is left — the session is respaced back to
   * {@link QUEUE_POSITION_STEP} intervals in the order asked for, which both
   * completes this move and restores room for the next one.
   *
   * `undefined` when the message or the anchor is not queued, including an
   * anchor that belongs to a DIFFERENT session: a queue can only be reordered
   * against itself, and silently reparenting a message to another session's
   * queue would be the worst possible reading of the request. Moving a message
   * against itself is accepted as the no-op it is.
   *
   * @param messageId - The message to move
   * @param target - The anchor to land before or after
   */
  move(messageId: string, target: MoveTarget): QueuedMessageRecord | undefined {
    const row = this.row(messageId);
    if (!row) return undefined;
    const anchorId = 'before' in target ? target.before : target.after;
    if (anchorId === messageId) return toRecord(row);

    const others = this.rows(row.sessionId).filter((r) => r.id !== messageId);
    const anchorIndex = others.findIndex((r) => r.id === anchorId);
    if (anchorIndex === -1) return undefined;

    // Where the moved row goes in the order the OTHER rows already hold.
    const slot = 'before' in target ? anchorIndex : anchorIndex + 1;
    // 0 is the head sentinel: no lower neighbour, so the whole span below the
    // first row is available. Past the tail there is no upper neighbour either,
    // so one full step beyond the last row is the landing place.
    const below = slot === 0 ? 0 : others[slot - 1]!.position;
    const above = slot === others.length ? below + QUEUE_POSITION_STEP * 2 : others[slot]!.position;
    const midpoint = Math.floor((below + above) / 2);

    if (midpoint > below && midpoint < above) {
      this.db
        .update(sessionMessageQueue)
        .set({ position: midpoint })
        .where(eq(sessionMessageQueue.id, messageId))
        .run();
      return toRecord({ ...row, position: midpoint });
    }

    const ordered = [...others.slice(0, slot), row, ...others.slice(slot)];
    this.renumber(ordered);
    return toRecord({ ...row, position: (slot + 1) * QUEUE_POSITION_STEP });
  }

  /**
   * Empty a session's queue and hand back what was removed, IN ORDER.
   *
   * The order is the promise: Stop cancels the queue (D4) and the cockpit has
   * to be able to put those messages back the way the person left them, so a
   * caller that discards the order cannot reconstruct it from anywhere else.
   *
   * @param sessionId - The session whose queue to empty
   */
  clear(sessionId: string): QueuedMessageRecord[] {
    return this.db.transaction((tx) => {
      const rows = tx
        .select()
        .from(sessionMessageQueue)
        .where(eq(sessionMessageQueue.sessionId, sessionId))
        .orderBy(sessionMessageQueue.position)
        .all();
      if (rows.length === 0) return [];
      tx.delete(sessionMessageQueue).where(eq(sessionMessageQueue.sessionId, sessionId)).run();
      return rows.map(toRecord);
    });
  }

  /**
   * Carry a session's queue onto a new id, alongside the rebind that moves its
   * `session_metadata` row.
   *
   * This is load-bearing and easy to miss: a brand-new session is written under
   * the request UUID and gains its canonical SDK id mid-first-turn. Rows left
   * behind at the old key are invisible forever — no window lists them, and the
   * dispatcher never fires them — so the person's queue would silently
   * evaporate on the very first turn.
   *
   * A destination that already has a queue keeps it, with the moved messages
   * appended behind it in their own order. Interleaving by position would be
   * arbitrary (two sessions' position spaces mean nothing to each other), and
   * refusing would strand the rows this method exists to rescue.
   *
   * Idempotent: matching ids and an empty source are both no-ops, so a rekey
   * replayed after a retry moves nothing twice.
   *
   * @param fromId - The id the rows are stored under today
   * @param toId - The canonical id the session is now known by
   */
  rekeySession(fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.db.transaction((tx) => {
      const moving = tx
        .select()
        .from(sessionMessageQueue)
        .where(eq(sessionMessageQueue.sessionId, fromId))
        .orderBy(sessionMessageQueue.position)
        .all();
      if (moving.length === 0) return;
      const destinationTail =
        tx
          .select({ value: max(sessionMessageQueue.position) })
          .from(sessionMessageQueue)
          .where(eq(sessionMessageQueue.sessionId, toId))
          .get()?.value ?? 0;
      moving.forEach((row, index) => {
        tx.update(sessionMessageQueue)
          .set({
            sessionId: toId,
            position: destinationTail + (index + 1) * QUEUE_POSITION_STEP,
          })
          .where(eq(sessionMessageQueue.id, row.id))
          .run();
      });
    });
  }

  /**
   * Delete every queued message belonging to any of the named sessions, and
   * report how many rows went. The storage half of session teardown: the sweep
   * that evicts dead sessions calls this so an abandoned session cannot hold
   * queue rows for the life of the install.
   *
   * Chunked at {@link DELETE_CHUNK_SIZE}: every id is one bound SQL variable,
   * and a list past SQLite's compiled-in ceiling would fail the whole delete
   * rather than part of it. The chunking lives here rather than at the caller so
   * no future caller has to remember it.
   *
   * @param sessionIds - The sessions to clear out; an empty list does nothing
   */
  deleteForSessions(sessionIds: string[]): number {
    let removed = 0;
    for (let i = 0; i < sessionIds.length; i += DELETE_CHUNK_SIZE) {
      const chunk = sessionIds.slice(i, i + DELETE_CHUNK_SIZE);
      removed += this.db
        .delete(sessionMessageQueue)
        .where(inArray(sessionMessageQueue.sessionId, chunk))
        .run().changes;
    }
    return removed;
  }

  /**
   * Every session id that holds at least one queued message.
   *
   * The boot reconcile's input (`reconcile-session-rows.ts`): the only way to
   * find rows whose session disappeared while this server was DOWN is to start
   * from the rows themselves, because nothing announced their session's
   * departure to a process that was not running. Distinct ids rather than rows —
   * a thousand-message queue is one question, not a thousand.
   */
  listSessionIds(): string[] {
    return this.db
      .selectDistinct({ sessionId: sessionMessageQueue.sessionId })
      .from(sessionMessageQueue)
      .all()
      .map((row) => row.sessionId);
  }

  /** One session's rows, ordered head-first. */
  private rows(sessionId: string): SessionMessageQueueRow[] {
    return this.db
      .select()
      .from(sessionMessageQueue)
      .where(eq(sessionMessageQueue.sessionId, sessionId))
      .orderBy(sessionMessageQueue.position)
      .all();
  }

  /** One row by message id. */
  private row(messageId: string): SessionMessageQueueRow | undefined {
    return this.db
      .select()
      .from(sessionMessageQueue)
      .where(eq(sessionMessageQueue.id, messageId))
      .get();
  }

  /** The position one full step past a session's current tail. */
  private nextPosition(sessionId: string): number {
    const tail =
      this.db
        .select({ value: max(sessionMessageQueue.position) })
        .from(sessionMessageQueue)
        .where(eq(sessionMessageQueue.sessionId, sessionId))
        .get()?.value ?? 0;
    return tail + QUEUE_POSITION_STEP;
  }

  /** Respace a whole session's queue to even steps in the order given. */
  private renumber(ordered: SessionMessageQueueRow[]): void {
    this.db.transaction((tx) => {
      ordered.forEach((row, index) => {
        const position = (index + 1) * QUEUE_POSITION_STEP;
        if (position === row.position) return;
        tx.update(sessionMessageQueue)
          .set({ position })
          .where(eq(sessionMessageQueue.id, row.id))
          .run();
      });
    });
  }
}

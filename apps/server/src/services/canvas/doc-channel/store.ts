/**
 * Synchronous persistence primitives for document channels.
 *
 * Authorization, routing policy and publication belong to the caller. Every
 * mutation accepts an existing transaction so lifecycle and admission changes
 * can commit with their source records instead of leaving partial receipts.
 *
 * @module server/services/canvas/doc-channel/store
 */
import {
  and,
  asc,
  eq,
  gt,
  isNull,
  lte,
  or,
  sql,
  canvasDocChannels,
  canvasDocEvents,
  canvasDocGrants,
  canvasDocBatches,
  canvasDocDeliveries,
  canvasDocIdentityIntents,
  canvasDocWriteIntents,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import {
  CANVAS_CHANNEL_STATE_BYTES,
  CanvasChannelStateSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { assertJson, assertRowJson, readChecked, DocChannelCorruptionError } from './store-json.js';
export { DocChannelCorruptionError } from './store-json.js';
import { documentTransaction, type SynchronousResult } from './store-transaction.js';
import { requireDocEventUuidVacant, readDocEventRow } from './writes/reservation-policy-census.js';
import { consumeCheckboxReservationAppend } from './writes/reservation-bridge.js';
import { markDocWaitingWarning, markAcceptedDocWaitingWarning } from './store-warnings.js';

type EventInput = Omit<typeof canvasDocEvents.$inferInsert, 'docSeq'>;
const storeBindings = new WeakMap<
  DocChannelStore,
  { db: Db; append: (input: EventInput, tx: DbTransaction) => DocEventRow }
>();

/** Constructor identity only; neither a public connection getter nor an overridable transaction probe. */
export function requireDocChannelStoreDatabase(store: DocChannelStore, expected: Db): void {
  if (storeBindings.get(store)?.db !== expected)
    throw new Error('Checkbox authority requires its genuine store transaction database.');
}
/** Fixed bridge consumes its internally staged append; callers cannot supply event data or credit. */
export function appendConvertedCheckboxEvent(
  store: DocChannelStore,
  tx: DbTransaction
): DocEventRow {
  const binding = storeBindings.get(store);
  if (!binding) throw new Error('Checkbox conversion requires a genuine store.');
  return binding.append(consumeCheckboxReservationAppend(store, tx), tx);
}

/** A stored channel, independent of the physical canvas document. */
export type DocChannelRow = typeof canvasDocChannels.$inferSelect;
/** One durable event, ordered within its document. */
export type DocEventRow = typeof canvasDocEvents.$inferSelect;
/** Stable route authority evidence. */
export type DocGrantRow = typeof canvasDocGrants.$inferSelect;
/** An immutable or pending delivery batch. */
export type DocBatchRow = typeof canvasDocBatches.$inferSelect;
/** One input's route outcome, retained after coalescing. */
export type DocDeliveryRow = typeof canvasDocDeliveries.$inferSelect;
/** Recoverable ownership movement evidence. */
export type DocIdentityIntentRow = typeof canvasDocIdentityIntents.$inferSelect;
/** Recoverable filesystem operation evidence. */
export type DocWriteIntentRow = typeof canvasDocWriteIntents.$inferSelect;

/** A mutation addressed a channel that no longer accepts writes. */
export class DocChannelClosedError extends Error {
  readonly code = 'DOC_CHANNEL_CLOSED';
  /** Build a safe channel closure refusal. */
  constructor(readonly documentId: string) {
    super('The document channel is closed or absent.');
    this.name = 'DocChannelClosedError';
  }
}

/** A revision compare-and-set did not match current state. */
export class DocChannelStateConflictError extends Error {
  readonly code = 'DOC_CHANNEL_STATE_CONFLICT';
  /** Build a safe optimistic concurrency refusal. */
  constructor() {
    super('The document state revision changed.');
    this.name = 'DocChannelStateConflictError';
  }
}

/** Transaction-capable document channel storage with no publication side effects. */
export class DocChannelStore {
  /** Build a store over the production SQLite connection. */
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
    storeBindings.set(this, { db, append: (input, tx) => this.#appendEvent(input, tx) });
  }

  /** Compose synchronous source mutations atomically; asynchronous callbacks roll back. */
  transaction<T>(work: (tx: DbTransaction) => T & SynchronousResult<T>): T {
    return documentTransaction(this.#db, work);
  }

  /** Create a channel without modifying an existing channel on repeated initialization. */
  initialize(input: typeof canvasDocChannels.$inferInsert, tx?: DbTransaction): DocChannelRow {
    assertRowJson(input);
    const executor = tx ?? this.#db;
    executor.insert(canvasDocChannels).values(input).onConflictDoNothing().run();
    return this.#getChannel(input.documentId, tx)!;
  }

  /** Read one channel; a physical document can be gone while its tombstone remains. */
  getChannel(documentId: string, tx?: DbTransaction): DocChannelRow | undefined {
    return this.#getChannel(documentId, tx);
  }

  #getChannel(documentId: string, tx?: DbTransaction): DocChannelRow | undefined {
    return readChecked('canvas_doc_channels', documentId, () =>
      (tx ?? this.#db)
        .select()
        .from(canvasDocChannels)
        .where(eq(canvasDocChannels.documentId, documentId))
        .get()
    );
  }

  /** Allocate the next sequence and append an event in the caller's atomic unit. */
  appendEvent(
    input: Omit<typeof canvasDocEvents.$inferInsert, 'docSeq'>,
    tx?: DbTransaction
  ): DocEventRow {
    if (!tx) return this.transaction((current) => this.appendEvent(input, current));
    assertRowJson(input);
    const channel = this.#getChannel(input.documentId, tx);
    if (!channel || channel.closedAt !== null) throw new DocChannelClosedError(input.documentId);
    requireDocEventUuidVacant(tx, input.documentId, input.eventId);
    return this.#appendEvent(input, tx);
  }

  #appendEvent(input: EventInput, tx: DbTransaction): DocEventRow {
    assertRowJson(input);
    const channel = this.#getChannel(input.documentId, tx);
    if (!channel || channel.closedAt !== null) throw new DocChannelClosedError(input.documentId);
    if (
      !Number.isSafeInteger(channel.nextDocSeq) ||
      channel.nextDocSeq < 1 ||
      channel.nextDocSeq >= Number.MAX_SAFE_INTEGER
    )
      throw new DocChannelCorruptionError('canvas_doc_channels', input.documentId);
    const changed = tx
      .update(canvasDocChannels)
      .set({ nextDocSeq: channel.nextDocSeq + 1, updatedAt: input.receivedAt })
      .where(
        and(
          eq(canvasDocChannels.documentId, input.documentId),
          eq(canvasDocChannels.nextDocSeq, channel.nextDocSeq),
          isNull(canvasDocChannels.closedAt)
        )
      )
      .run().changes;
    if (changed !== 1) throw new Error('Document sequence allocation raced.');
    tx.insert(canvasDocEvents)
      .values({
        ...input,
        docSeq: channel.nextDocSeq,
        payload: input.payload === null ? sql`'null'` : input.payload,
        provenance: input.provenance === null ? sql`'null'` : input.provenance,
      })
      .run();
    return this.#getEvent(input.documentId, input.eventId, tx)!;
  }

  /** Read the original input by its document-local idempotency key. */
  getEvent(documentId: string, eventId: string, tx?: DbTransaction): DocEventRow | undefined {
    return this.#getEvent(documentId, eventId, tx);
  }

  #getEvent(documentId: string, eventId: string, tx?: DbTransaction): DocEventRow | undefined {
    return readDocEventRow(tx ?? this.#db, documentId, eventId);
  }

  /** Read a bounded sequence page through an optional captured high watermark. */
  pageEvents(
    documentId: string,
    since: number,
    limit: number,
    highWatermark?: number
  ): DocEventRow[] {
    if (
      !Number.isSafeInteger(since) ||
      since < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new RangeError('Invalid document replay page.');
    return readChecked('canvas_doc_events', documentId, () =>
      this.#db
        .select()
        .from(canvasDocEvents)
        .where(
          and(
            eq(canvasDocEvents.documentId, documentId),
            gt(canvasDocEvents.docSeq, since),
            highWatermark === undefined ? undefined : lte(canvasDocEvents.docSeq, highWatermark)
          )
        )
        .orderBy(asc(canvasDocEvents.docSeq))
        .limit(limit)
        .all()
    );
  }

  /** Persist route evidence in an existing source transaction. */
  insertGrant(input: typeof canvasDocGrants.$inferInsert, tx?: DbTransaction): void {
    assertRowJson(input);
    (tx ?? this.#db).insert(canvasDocGrants).values(input).run();
  }

  /** Read one exact authority record. */
  getGrant(grantId: string, tx?: DbTransaction): DocGrantRow | undefined {
    return readChecked('canvas_doc_grants', grantId, () =>
      (tx ?? this.#db)
        .select()
        .from(canvasDocGrants)
        .where(eq(canvasDocGrants.grantId, grantId))
        .get()
    );
  }

  /** Persist a pending or immutable batch; database slot indexes enforce exclusivity. */
  insertBatch(input: typeof canvasDocBatches.$inferInsert, tx?: DbTransaction): void {
    assertRowJson(input);
    (tx ?? this.#db)
      .insert(canvasDocBatches)
      .values({
        ...input,
        effectivePayload: input.effectivePayload === null ? sql`'null'` : input.effectivePayload,
      })
      .run();
  }

  /** Read one batch, retaining immutable generation and source correlation. */
  getBatch(batchId: string, tx?: DbTransaction): DocBatchRow | undefined {
    return readChecked('canvas_doc_batches', batchId, () =>
      (tx ?? this.#db)
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.batchId, batchId))
        .get()
    );
  }

  /** Acquire an expired/free lease exactly once for a known generation and state. */
  acquireLease(
    input: {
      batchId: string;
      generation: string;
      status: DocBatchRow['status'];
      now: string;
      leaseUntil: string;
    },
    tx?: DbTransaction
  ): DocBatchRow | undefined {
    if (!tx) return this.transaction((current) => this.acquireLease(input, current));
    if (input.leaseUntil <= input.now)
      throw new RangeError('A lease must expire after acquisition.');
    const batch = this.getBatch(input.batchId, tx);
    if (!batch) return undefined;
    if (
      !Number.isSafeInteger(batch.attempt) ||
      batch.attempt < 0 ||
      batch.attempt >= Number.MAX_SAFE_INTEGER
    )
      throw new DocChannelCorruptionError('canvas_doc_batches', input.batchId);
    const changed = tx
      .update(canvasDocBatches)
      .set({ leaseUntil: input.leaseUntil, attempt: batch.attempt + 1, updatedAt: input.now })
      .where(
        and(
          eq(canvasDocBatches.batchId, input.batchId),
          eq(canvasDocBatches.generation, input.generation),
          eq(canvasDocBatches.status, input.status),
          eq(canvasDocBatches.attempt, batch.attempt),
          or(isNull(canvasDocBatches.leaseUntil), lte(canvasDocBatches.leaseUntil, input.now))
        )
      )
      .run().changes;
    return changed === 1 ? this.getBatch(input.batchId, tx) : undefined;
  }

  /** Mark one waiting generation in the same transaction as its durable warning event. */
  markWaitingWarning(batchId: string, generation: string, now: string, tx: DbTransaction): boolean {
    return markDocWaitingWarning(batchId, generation, now, tx);
  }

  /** Mark an accepted wait without changing its dispatch lease or selected input. */
  markAcceptedWaitingWarning(
    receiptId: string,
    generation: string,
    now: string,
    tx: DbTransaction
  ): boolean {
    return markAcceptedDocWaitingWarning(receiptId, generation, now, tx);
  }

  /** Change a batch only when the caller still owns its generation/attempt/state. */
  transitionBatch(
    input: {
      batchId: string;
      generation: string;
      attempt: number;
      expectedStatus: DocBatchRow['status'];
      status: DocBatchRow['status'];
      updatedAt: string;
    },
    tx?: DbTransaction
  ): boolean {
    return (
      (tx ?? this.#db)
        .update(canvasDocBatches)
        .set({ status: input.status, updatedAt: input.updatedAt })
        .where(
          and(
            eq(canvasDocBatches.batchId, input.batchId),
            eq(canvasDocBatches.generation, input.generation),
            eq(canvasDocBatches.attempt, input.attempt),
            eq(canvasDocBatches.status, input.expectedStatus)
          )
        )
        .run().changes === 1
    );
  }

  /** Persist an individual input outcome without deleting its event. */
  insertDelivery(input: typeof canvasDocDeliveries.$inferInsert, tx?: DbTransaction): void {
    assertRowJson(input);
    (tx ?? this.#db).insert(canvasDocDeliveries).values(input).run();
  }

  /** Inspect all route outcomes for an input. */
  listDeliveries(documentId: string, eventId: string, tx?: DbTransaction): DocDeliveryRow[] {
    return readChecked('canvas_doc_deliveries', `${documentId}/${eventId}`, () =>
      (tx ?? this.#db)
        .select()
        .from(canvasDocDeliveries)
        .where(
          and(
            eq(canvasDocDeliveries.documentId, documentId),
            eq(canvasDocDeliveries.eventId, eventId)
          )
        )
        .orderBy(asc(canvasDocDeliveries.routeId))
        .all()
    );
  }

  /** Atomically replace a validated state value, advance revision and append its event. */
  replaceState(
    input: {
      documentId: string;
      expectedStateRev: number;
      state: DocChannelRow['state'];
      event: Omit<typeof canvasDocEvents.$inferInsert, 'docSeq'>;
    },
    tx?: DbTransaction
  ): DocEventRow {
    if (!tx) return this.transaction((current) => this.replaceState(input, current));
    assertJson(input.state, CANVAS_CHANNEL_STATE_BYTES);
    if (!CanvasChannelStateSchema.safeParse(input.state).success)
      throw new TypeError('Invalid state object');
    if (
      !Number.isSafeInteger(input.expectedStateRev) ||
      input.expectedStateRev < 0 ||
      input.expectedStateRev >= Number.MAX_SAFE_INTEGER
    )
      throw new RangeError('Invalid document state revision.');
    if (input.event.documentId !== input.documentId)
      throw new Error('State event document mismatch.');
    requireDocEventUuidVacant(tx, input.documentId, input.event.eventId);
    const changed = tx
      .update(canvasDocChannels)
      .set({
        state: input.state,
        stateRev: input.expectedStateRev + 1,
        updatedAt: input.event.receivedAt,
      })
      .where(
        and(
          eq(canvasDocChannels.documentId, input.documentId),
          eq(canvasDocChannels.stateRev, input.expectedStateRev),
          isNull(canvasDocChannels.closedAt)
        )
      )
      .run().changes;
    if (changed !== 1) throw new DocChannelStateConflictError();
    return this.appendEvent(input.event, tx);
  }

  /** Retain a closed channel; caller revokes/cancels related records in the same transaction. */
  markClosed(
    documentId: string,
    closedAt: string,
    evidence: DocChannelRow['closureEvidence'],
    tx?: DbTransaction
  ): boolean {
    assertJson(evidence);
    return (
      (tx ?? this.#db)
        .update(canvasDocChannels)
        .set({ closedAt, closureEvidence: evidence, updatedAt: closedAt })
        .where(
          and(eq(canvasDocChannels.documentId, documentId), isNull(canvasDocChannels.closedAt))
        )
        .run().changes === 1
    );
  }

  /** Store durable evidence for a canonical identity move. */
  insertIdentityIntent(
    input: typeof canvasDocIdentityIntents.$inferInsert,
    tx?: DbTransaction
  ): void {
    assertRowJson(input);
    (tx ?? this.#db).insert(canvasDocIdentityIntents).values(input).run();
  }

  /** Read identity repair evidence without inventing a successful empty record. */
  getIdentityIntent(id: string, tx?: DbTransaction): DocIdentityIntentRow | undefined {
    return readChecked('canvas_doc_identity_intents', id, () =>
      (tx ?? this.#db)
        .select()
        .from(canvasDocIdentityIntents)
        .where(eq(canvasDocIdentityIntents.intentId, id))
        .get()
    );
  }

  /** Store before/after evidence before a filesystem effect. */
  insertWriteIntent(input: typeof canvasDocWriteIntents.$inferInsert, tx?: DbTransaction): void {
    if (!tx) return this.transaction((current) => this.insertWriteIntent(input, current));
    assertRowJson(input);
    requireDocEventUuidVacant(tx, input.documentId, input.eventId);
    tx.insert(canvasDocWriteIntents).values(input).run();
  }

  /** Read a write intent for crash reconciliation. */
  getWriteIntent(id: string, tx?: DbTransaction): DocWriteIntentRow | undefined {
    return readChecked('canvas_doc_write_intents', id, () =>
      (tx ?? this.#db)
        .select()
        .from(canvasDocWriteIntents)
        .where(eq(canvasDocWriteIntents.intentId, id))
        .get()
    );
  }

  /** Update mergeable input only while this exact generation remains pending. */
  updatePendingBatch(
    input: {
      batchId: string;
      generation: string;
      status: 'pending' | 'waiting';
      inputEventIds: DocBatchRow['inputEventIds'];
      effectivePayload: DocBatchRow['effectivePayload'];
      updatedAt: string;
    },
    tx?: DbTransaction
  ): boolean {
    assertJson(input.inputEventIds);
    assertJson(input.effectivePayload, 80 * 1024);
    return (
      (tx ?? this.#db)
        .update(canvasDocBatches)
        .set({
          inputEventIds: input.inputEventIds,
          effectivePayload: input.effectivePayload === null ? sql`'null'` : input.effectivePayload,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(canvasDocBatches.batchId, input.batchId),
            eq(canvasDocBatches.generation, input.generation),
            eq(canvasDocBatches.status, input.status)
          )
        )
        .run().changes === 1
    );
  }

  /** Advance one delivery outcome only while its previous status still matches. */
  updateDelivery(
    input: {
      documentId: string;
      eventId: string;
      routeId: string;
      expectedStatus: DocDeliveryRow['status'];
      changes: Partial<
        Omit<typeof canvasDocDeliveries.$inferInsert, 'documentId' | 'eventId' | 'routeId'>
      >;
    },
    tx?: DbTransaction
  ): boolean {
    assertRowJson(input.changes);
    return (
      (tx ?? this.#db)
        .update(canvasDocDeliveries)
        .set(input.changes)
        .where(
          and(
            eq(canvasDocDeliveries.documentId, input.documentId),
            eq(canvasDocDeliveries.eventId, input.eventId),
            eq(canvasDocDeliveries.routeId, input.routeId),
            eq(canvasDocDeliveries.status, input.expectedStatus)
          )
        )
        .run().changes === 1
    );
  }

  /** Revoke an unchanged route revision without replacing its immutable approval evidence. */
  revokeGrant(grantId: string, revision: number, revokedAt: string, tx?: DbTransaction): boolean {
    return (
      (tx ?? this.#db)
        .update(canvasDocGrants)
        .set({ revokedAt })
        .where(
          and(
            eq(canvasDocGrants.grantId, grantId),
            eq(canvasDocGrants.revision, revision),
            isNull(canvasDocGrants.revokedAt)
          )
        )
        .run().changes === 1
    );
  }

  /** Advance an ownership intent only from the observed recovery state. */
  transitionIdentityIntent(
    intentId: string,
    expectedStatus: DocIdentityIntentRow['status'],
    changes: Pick<DocIdentityIntentRow, 'status' | 'updatedAt' | 'errorCode'>,
    tx?: DbTransaction
  ): boolean {
    return (
      (tx ?? this.#db)
        .update(canvasDocIdentityIntents)
        .set(changes)
        .where(
          and(
            eq(canvasDocIdentityIntents.intentId, intentId),
            eq(canvasDocIdentityIntents.status, expectedStatus)
          )
        )
        .run().changes === 1
    );
  }

  /** Advance a write intent without modifying its before/after source identity. */
  transitionWriteIntent(
    intentId: string,
    expectedStatus: DocWriteIntentRow['status'],
    changes: Pick<DocWriteIntentRow, 'status' | 'updatedAt' | 'errorCode' | 'evidence'>,
    tx?: DbTransaction
  ): boolean {
    assertJson(changes.evidence);
    return (
      (tx ?? this.#db)
        .update(canvasDocWriteIntents)
        .set(changes)
        .where(
          and(
            eq(canvasDocWriteIntents.intentId, intentId),
            eq(canvasDocWriteIntents.status, expectedStatus)
          )
        )
        .run().changes === 1
    );
  }
}

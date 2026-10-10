import { consumeOriginalDocPresenceAppend } from './current/current-operation-engine.js';
import {
  buildCurrentSequencePredicate,
  buildCurrentBatchTransitionPredicate,
  buildCurrentStatePredicate,
  buildCurrentPendingBatchPredicate,
  buildCurrentDeliveryTransitionPredicate,
  requireCurrentAppendBounds,
  buildCurrentEventInsertValues,
  requireCurrentStateInput,
  buildCurrentAppendRow,
  buildCurrentInputRow,
} from './current/current-operation-intentions.js';

import {
  auditCurrentAppendSlice,
  readCurrentStorePageEvents,
  readCurrentStoreGetBatch,
  readCurrentStoreListDeliveries,
  readCurrentStoreGetIdentityIntent,
} from './current/current-operation-row-audit.js';
import { sameCurrentDocData } from './current/current-operation-data.js';
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
  inArray,
  eq,
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
  assertJson,
  assertRowJson,
  readChecked,
  DocChannelCorruptionError,
} from './storage/store-json.js';
export { DocChannelCorruptionError } from './storage/store-json.js';
import { documentTransaction, type SynchronousResult } from './storage/store-transaction.js';
import {
  readPreparedChannel,
  readPreparedGrant,
  readPreparedIntent,
} from './readers/prepared-readers.js';
import {
  requireDocEventUuidVacant,
  readDocEventRow,
} from './writes/reservations/reservation-policy-census.js';
import { consumeCheckboxReservationAppend } from './writes/reservations/reservation-bridge.js';
import { markDocWaitingWarning, markAcceptedDocWaitingWarning } from './storage/store-warnings.js';
import {
  queueCommittedDocChannel,
  queueCommittedDocEvent,
  queueCommittedDocGrant,
} from './committed-events.js';

import {
  readCurrentDocIngressInput,
  assertCurrentDocOperation,
  readCurrentDocStoreOperation,
  failCurrentDocOperation,
  type DocChannelAuthorization,
} from './authorization.js';
import { envelopeIdentity } from './envelope.js';
export type EventInput = Omit<typeof canvasDocEvents.$inferInsert, 'docSeq'>;
const storeBindings = new WeakMap<
  DocChannelStore,
  {
    db: Db;
    append: (input: EventInput, tx: DbTransaction) => DocEventRow;
    relay: Readonly<Pick<DocChannelStore, 'transaction' | 'getBatch' | 'getEvent'>>;
    downstream: Readonly<
      Pick<
        DocChannelStore,
        'transaction' | 'getChannel' | 'getBatch' | 'getEvent' | 'listDeliveries' | 'appendEvent'
      >
    >;
    grant: Readonly<
      Pick<
        DocChannelStore,
        'transaction' | 'getChannel' | 'insertGrant' | 'getGrant' | 'revokeGrant'
      >
    >;
  }
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
const currentAppendIntentions = new WeakMap<
  DbTransaction,
  { store: DocChannelStore; documentId: string; firstSeq: number; rows: DocEventRow[] }
>();

/** Own document-channel storage and its constructor-captured operations. */
export class DocChannelStore {
  /** Build a store over the production SQLite connection. */
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
    storeBindings.set(this, {
      db,
      append: (input, tx) => this.#appendEvent(input, tx),
      downstream: Object.freeze({
        transaction: <T>(work: (tx: DbTransaction) => T & SynchronousResult<T>) =>
          documentTransaction(db, work),
        getChannel: (id: string, tx?: DbTransaction) => this.#getChannel(id, tx),
        getBatch: (id: string, tx?: DbTransaction) => readCurrentStoreGetBatch(tx ?? db, id),
        getEvent: (documentId: string, id: string, tx?: DbTransaction) =>
          this.#getEvent(documentId, id, tx),
        listDeliveries: (documentId: string, id: string, tx?: DbTransaction) =>
          this.#listDeliveries(documentId, id, tx),
        appendEvent: (input: EventInput, tx?: DbTransaction) => {
          if (!tx) throw new Error('Native downstream append requires its original transaction.');
          requireDocEventUuidVacant(tx, input.documentId, input.eventId);
          return this.#appendEvent(input, tx);
        },
      }),
      relay: Object.freeze({
        transaction: <T>(work: (tx: DbTransaction) => T & SynchronousResult<T>) =>
          documentTransaction(db, work),
        getBatch: (id: string, tx?: DbTransaction) => readCurrentStoreGetBatch(tx ?? db, id),
        getEvent: (documentId: string, id: string, tx?: DbTransaction) =>
          this.#getEvent(documentId, id, tx),
      }),
      grant: Object.freeze({
        transaction: <T>(work: (tx: DbTransaction) => T & SynchronousResult<T>) =>
          documentTransaction(db, work),
        getChannel: (id: string, tx?: DbTransaction) => this.#getChannel(id, tx),
        insertGrant: (input: typeof canvasDocGrants.$inferInsert, tx?: DbTransaction) =>
          this.#insertGrant(input, tx),
        getGrant: (id: string, tx?: DbTransaction) => this.#getGrant(id, tx),
        revokeGrant: (id: string, revision: number, time: string, tx?: DbTransaction) =>
          this.#revokeGrant(id, revision, time, tx),
      }),
    });
  }

  /** Compose synchronous source mutations atomically; asynchronous callbacks roll back. */
  transaction<T>(work: (tx: DbTransaction) => T & SynchronousResult<T>): T {
    return documentTransaction(this.#db, work);
  }

  /** Create a channel without modifying an existing channel on repeated initialization. */
  initialize(input: typeof canvasDocChannels.$inferInsert, tx?: DbTransaction): DocChannelRow {
    assertRowJson(input);
    const executor = tx ?? this.#db;
    const inserted = executor
      .insert(canvasDocChannels)
      .values(input)
      .onConflictDoNothing()
      .run().changes;
    const channel = this.#getChannel(input.documentId, tx)!;
    if (inserted)
      queueCommittedDocChannel(this.#db, {
        documentId: channel.documentId,
        createdAt: channel.createdAt,
      });
    return channel;
  }

  /** Read one channel; a physical document can be gone while its tombstone remains. */
  getChannel(documentId: string, tx?: DbTransaction): DocChannelRow | undefined {
    return this.#getChannel(documentId, tx);
  }
  #getChannel(documentId: string, tx?: DbTransaction): DocChannelRow | undefined {
    return readChecked('canvas_doc_channels', documentId, () =>
      readPreparedChannel(tx ?? this.#db, documentId)
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
    requireCurrentAppendBounds(channel, input.documentId);
    // Capture complete intended rows before the counter update or any INSERT trigger.
    const operation = readCurrentDocStoreOperation(this, tx);
    const intended = buildCurrentAppendRow(input, channel.nextDocSeq);
    if (operation) {
      if (operation.documentId !== input.documentId)
        return failCurrentDocOperation(this, tx, new Error('Current append changed its document.'));
      let own = currentAppendIntentions.get(tx);
      if (!own) {
        own = { store: this, documentId: input.documentId, firstSeq: channel.nextDocSeq, rows: [] };
        currentAppendIntentions.set(tx, own);
      }
      if (
        own.store !== this ||
        channel.nextDocSeq !== own.firstSeq + own.rows.length ||
        own.rows.some((row) => row.eventId === input.eventId)
      )
        return failCurrentDocOperation(
          this,
          tx,
          new Error('Current append sequence or UUID was reused.')
        );
      own.rows.push(intended);
    }
    const changed = tx
      .update(canvasDocChannels)
      .set({ nextDocSeq: channel.nextDocSeq + 1, updatedAt: input.receivedAt })
      .where(buildCurrentSequencePredicate(input.documentId, channel.nextDocSeq))
      .run().changes;
    if (changed !== 1) throw new Error('Document sequence allocation raced.');
    tx.insert(canvasDocEvents)
      .values(buildCurrentEventInsertValues(input, channel.nextDocSeq))
      .run();
    const event = this.#getEvent(input.documentId, input.eventId, tx)!;
    if (operation && !sameCurrentDocData(event, intended))
      return failCurrentDocOperation(
        this,
        tx,
        new Error('Current append trigger changed its intended row.')
      );
    queueCommittedDocEvent(this.#db, event);
    return event;
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
    return readCurrentStorePageEvents(this.#db, documentId, since, limit, highWatermark);
  }

  /** Read the at most two replay pages' current full event rows in the caller transaction. */
  readReplayEvents(documentId: string, eventIds: string[], tx: DbTransaction): DocEventRow[] {
    if (eventIds.length > 400) throw new RangeError('Invalid replay event selection.');
    if (!eventIds.length) return [];
    return readChecked('canvas_doc_events', documentId, () =>
      tx
        .select()
        .from(canvasDocEvents)
        .where(
          and(
            eq(canvasDocEvents.documentId, documentId),
            inArray(canvasDocEvents.eventId, eventIds)
          )
        )
        .all()
    );
  }

  /** Read one replay receipt page's current outcomes, retaining every route in original order. */
  readReplayDeliveries(
    documentId: string,
    eventIds: string[],
    tx: DbTransaction
  ): DocDeliveryRow[] {
    if (eventIds.length > 200) throw new RangeError('Invalid replay receipt selection.');
    if (!eventIds.length) return [];
    return readChecked('canvas_doc_deliveries', documentId, () =>
      tx
        .select()
        .from(canvasDocDeliveries)
        .where(
          and(
            eq(canvasDocDeliveries.documentId, documentId),
            inArray(canvasDocDeliveries.eventId, eventIds)
          )
        )
        .orderBy(asc(canvasDocDeliveries.eventId), asc(canvasDocDeliveries.routeId))
        .all()
    );
  }

  /** Persist route evidence in an existing source transaction. */
  insertGrant(input: typeof canvasDocGrants.$inferInsert, tx?: DbTransaction): void {
    return this.#insertGrant(input, tx);
  }
  #insertGrant(input: typeof canvasDocGrants.$inferInsert, tx?: DbTransaction): void {
    assertRowJson(input);
    (tx ?? this.#db).insert(canvasDocGrants).values(input).run();
    queueCommittedDocGrant(this.#db, this.#getGrant(input.grantId, tx)!);
  }

  /** Read one exact authority record. */
  getGrant(grantId: string, tx?: DbTransaction): DocGrantRow | undefined {
    return this.#getGrant(grantId, tx);
  }
  #getGrant(grantId: string, tx?: DbTransaction): DocGrantRow | undefined {
    return readChecked('canvas_doc_grants', grantId, () =>
      readPreparedGrant(tx ?? this.#db, grantId)
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
    return readCurrentStoreGetBatch(tx ?? this.#db, batchId);
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
        .where(buildCurrentBatchTransitionPredicate(input))
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
    return this.#listDeliveries(documentId, eventId, tx);
  }
  #listDeliveries(documentId: string, eventId: string, tx?: DbTransaction): DocDeliveryRow[] {
    return readCurrentStoreListDeliveries(tx ?? this.#db, documentId, eventId);
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
    requireCurrentStateInput(input);
    requireDocEventUuidVacant(tx, input.documentId, input.event.eventId);
    const changed = tx
      .update(canvasDocChannels)
      .set({
        state: input.state,
        stateRev: input.expectedStateRev + 1,
        updatedAt: input.event.receivedAt,
      })
      .where(buildCurrentStatePredicate(input))
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
    return readCurrentStoreGetIdentityIntent(tx ?? this.#db, id);
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
      readPreparedIntent(tx ?? this.#db, id)
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
        .where(buildCurrentPendingBatchPredicate(input))
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
        .where(buildCurrentDeliveryTransitionPredicate(input))
        .run().changes === 1
    );
  }

  /** Revoke an unchanged route revision without replacing its immutable approval evidence. */
  revokeGrant(grantId: string, revision: number, revokedAt: string, tx?: DbTransaction): boolean {
    return this.#revokeGrant(grantId, revision, revokedAt, tx);
  }
  #revokeGrant(grantId: string, revision: number, revokedAt: string, tx?: DbTransaction): boolean {
    const changed =
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
        .run().changes === 1;
    if (changed) queueCommittedDocGrant(this.#db, this.#getGrant(grantId, tx)!);
    return changed;
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

/** Genuine private append; accepts no caller event, access, source or capacity credit. */
export function appendCurrentDocInput(
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): DocEventRow {
  const own = storeBindings.get(store);
  if (!own) throw new Error('Current input append requires a genuine store.');
  const input = readCurrentDocIngressInput(authorization, store, tx);
  if (!input.now || !input.access) throw new Error('Current input append lacks its fixed phase.');
  const identity = envelopeIdentity(input.event);
  assertCurrentDocOperation(authorization, store, tx);
  requireDocEventUuidVacant(tx, input.documentId, input.event.id);
  return own.append(buildCurrentInputRow(input, identity, input.now, input.access.provenance), tx);
}

/** Fixed quiet presence append: caller supplies no event, viewer, clock or routing data. */
export function appendOriginalDocPresenceEvent(
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): DocEventRow {
  const own = storeBindings.get(store);
  if (!own) throw new Error('Presence append requires its original store.');
  assertCurrentDocOperation(authorization, store, tx);
  const input = consumeOriginalDocPresenceAppend(authorization, store, tx);
  requireDocEventUuidVacant(tx, input.documentId, input.eventId);
  return own.append(input, tx);
}
/** Complete pre-effect append intentions; caller cannot register, replace or reset them. */
export function auditCurrentDocAppendIntentions(
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): readonly DocEventRow[] {
  readCurrentDocIngressInput(authorization, store, tx);
  const own = currentAppendIntentions.get(tx);
  if (!own || own.store !== store)
    return failCurrentDocOperation(store, tx, new Error('Current append intentions are absent.'));
  try {
    return auditCurrentAppendSlice(tx, own);
  } catch (cause) {
    return failCurrentDocOperation(store, tx, cause);
  }
}

/** Actual constructor-captured store implementations for the original grant core; no public method replacement. */
export function requireOriginalDocGrantStore(store: DocChannelStore, db: Db) {
  requireDocChannelStoreDatabase(store, db);
  return storeBindings.get(store)!.grant;
}

/** Only actual constructor-captured source reads/SQL; public reflection cannot replace these. */
export function requireOriginalDocumentRelayStore(store: DocChannelStore) {
  const own = storeBindings.get(store);
  if (!own) throw new Error('DOCUMENT_RELAY_ORIGINAL_STORE_REQUIRED');
  return own.relay;
}

/** Fixed actual sender dependency; no caller transaction or reflected store method. */
export function requireOriginalNativeDownstreamStore(store: DocChannelStore, db: Db) {
  requireDocChannelStoreDatabase(store, db);
  return storeBindings.get(store)!.downstream;
}

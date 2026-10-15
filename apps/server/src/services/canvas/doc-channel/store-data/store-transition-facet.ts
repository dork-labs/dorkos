import {
  and,
  eq,
  or,
  isNull,
  lte,
  sql,
  canvasDocBatches,
  canvasDocChannels,
  canvasDocEvents,
  canvasDocDeliveries,
  canvasDocIdentityIntents,
  canvasDocWriteIntents,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { assertJson, assertRowJson, DocChannelCorruptionError } from '../storage/store-json.js';
import { requireDocEventUuidVacant } from '../writes/reservations/reservation-policy-census.js';
import {
  buildCurrentBatchTransitionPredicate,
  buildCurrentStatePredicate,
  buildCurrentPendingBatchPredicate,
  buildCurrentDeliveryTransitionPredicate,
  requireCurrentStateInput,
} from '../current/current-operation-intentions.js';
import {
  readOriginalStoreTransitionFacet,
  DocChannelStateConflictError,
  type DocChannelRow,
  type DocEventRow,
  type DocBatchRow,
  type DocDeliveryRow,
  type DocIdentityIntentRow,
  type DocWriteIntentRow,
  type EventInput,
  type DocChannelStore,
} from '../store.js';
export interface OriginalStoreTransitionFacet {
  readonly db: Db;
  readonly transaction: DocChannelStore['transaction'];
  readonly getBatch: (id: string, tx?: DbTransaction) => DocBatchRow | undefined;
  readonly appendEvent: (input: EventInput, tx?: DbTransaction) => DocEventRow;
}

/** Insert the original document batch after exact private store-owner recognition. */
export function insertBatch(
  owner: object,
  input: typeof canvasDocBatches.$inferInsert,
  tx?: DbTransaction
): void {
  const own = readOriginalStoreTransitionFacet(owner);
  assertRowJson(input);
  (tx ?? own.db)
    .insert(canvasDocBatches)
    .values({
      ...input,
      effectivePayload: input.effectivePayload === null ? sql`'null'` : input.effectivePayload,
    })
    .run();
}

/** Acquire the original batch lease through its owning synchronous transaction. */
export function acquireLease(
  owner: object,
  input: {
    batchId: string;
    generation: string;
    status: DocBatchRow['status'];
    now: string;
    leaseUntil: string;
  },
  tx?: DbTransaction
): DocBatchRow | undefined {
  const own = readOriginalStoreTransitionFacet(owner);
  if (!tx) return own.transaction((current) => acquireLease(owner, input, current));
  if (input.leaseUntil <= input.now) throw new RangeError('A lease must expire after acquisition.');
  const batch = own.getBatch(input.batchId, tx);
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
  return changed === 1 ? own.getBatch(input.batchId, tx) : undefined;
}

/** Apply the original guarded batch state transition. */
export function transitionBatch(
  owner: object,
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
  const own = readOriginalStoreTransitionFacet(owner);
  return (
    (tx ?? own.db)
      .update(canvasDocBatches)
      .set({ status: input.status, updatedAt: input.updatedAt })
      .where(buildCurrentBatchTransitionPredicate(input))
      .run().changes === 1
  );
}

/** Replace the original state and record its event in the same owning transaction. */
export function replaceState(
  owner: object,
  input: {
    documentId: string;
    expectedStateRev: number;
    state: DocChannelRow['state'];
    event: Omit<typeof canvasDocEvents.$inferInsert, 'docSeq'>;
  },
  tx?: DbTransaction
): DocEventRow {
  const own = readOriginalStoreTransitionFacet(owner);
  if (!tx) return own.transaction((current) => replaceState(owner, input, current));
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
  return own.appendEvent(input.event, tx);
}

/** Record original channel closure through the current store owner. */
export function markClosed(
  owner: object,
  documentId: string,
  closedAt: string,
  evidence: DocChannelRow['closureEvidence'],
  tx?: DbTransaction
): boolean {
  const own = readOriginalStoreTransitionFacet(owner);
  assertJson(evidence);
  return (
    (tx ?? own.db)
      .update(canvasDocChannels)
      .set({ closedAt, closureEvidence: evidence, updatedAt: closedAt })
      .where(and(eq(canvasDocChannels.documentId, documentId), isNull(canvasDocChannels.closedAt)))
      .run().changes === 1
  );
}

/** Record the original identity intent after the private store gate. */
export function insertIdentityIntent(
  owner: object,
  input: typeof canvasDocIdentityIntents.$inferInsert,
  tx?: DbTransaction
): void {
  const own = readOriginalStoreTransitionFacet(owner);
  assertRowJson(input);
  (tx ?? own.db).insert(canvasDocIdentityIntents).values(input).run();
}

/** Record the original write intent after the private store gate. */
export function insertWriteIntent(
  owner: object,
  input: typeof canvasDocWriteIntents.$inferInsert,
  tx?: DbTransaction
): void {
  const own = readOriginalStoreTransitionFacet(owner);
  if (!tx) return own.transaction((current) => insertWriteIntent(owner, input, current));
  assertRowJson(input);
  requireDocEventUuidVacant(tx, input.documentId, input.eventId);
  tx.insert(canvasDocWriteIntents).values(input).run();
}

/** Update the original pending batch under its owning store transaction. */
export function updatePendingBatch(
  owner: object,
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
  const own = readOriginalStoreTransitionFacet(owner);
  assertJson(input.inputEventIds);
  assertJson(input.effectivePayload, 80 * 1024);
  return (
    (tx ?? own.db)
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

/** Update the original delivery record under the current private store owner. */
export function updateDelivery(
  owner: object,
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
  const own = readOriginalStoreTransitionFacet(owner);
  assertRowJson(input.changes);
  return (
    (tx ?? own.db)
      .update(canvasDocDeliveries)
      .set(input.changes)
      .where(buildCurrentDeliveryTransitionPredicate(input))
      .run().changes === 1
  );
}

/** Apply the original identity-intent transition under the private store gate. */
export function transitionIdentityIntent(
  owner: object,
  intentId: string,
  expectedStatus: DocIdentityIntentRow['status'],
  changes: Pick<DocIdentityIntentRow, 'status' | 'updatedAt' | 'errorCode'>,
  tx?: DbTransaction
): boolean {
  const own = readOriginalStoreTransitionFacet(owner);
  return (
    (tx ?? own.db)
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

/** Apply the original write-intent transition under the private store gate. */
export function transitionWriteIntent(
  owner: object,
  intentId: string,
  expectedStatus: DocWriteIntentRow['status'],
  changes: Pick<DocWriteIntentRow, 'status' | 'updatedAt' | 'errorCode' | 'evidence'>,
  tx?: DbTransaction
): boolean {
  const own = readOriginalStoreTransitionFacet(owner);
  assertJson(changes.evidence);
  return (
    (tx ?? own.db)
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

/** Readonly store projections; owning callers retain executor and currentness authority. */
import {
  and,
  eq,
  gt,
  lte,
  asc,
  canvasDocEvents,
  canvasDocBatches,
  canvasDocDeliveries,
  canvasDocIdentityIntents,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { readChecked } from '../storage/store-json.js';

/** Literal readonly store query; original class chooses its owning executor. */
export function readCurrentStorePageEvents(
  executor: Db,
  documentId: string,
  since: number,
  limit: number,
  highWatermark?: number
) {
  if (
    !Number.isSafeInteger(since) ||
    since < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new RangeError('Invalid document replay page.');
  return readChecked('canvas_doc_events', documentId, () =>
    executor
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

/** Literal readonly store query; original class chooses its owning executor. */
export function readCurrentStoreGetBatch(executor: Db | DbTransaction, batchId: string) {
  return readChecked('canvas_doc_batches', batchId, () =>
    executor.select().from(canvasDocBatches).where(eq(canvasDocBatches.batchId, batchId)).get()
  );
}

/** Literal readonly store query; original class chooses its owning executor. */
export function readCurrentStoreListDeliveries(
  executor: Db | DbTransaction,
  documentId: string,
  eventId: string
) {
  return readChecked('canvas_doc_deliveries', `${documentId}/${eventId}`, () =>
    executor
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

/** Literal readonly store query; original class chooses its owning executor. */
export function readCurrentStoreGetIdentityIntent(executor: Db | DbTransaction, id: string) {
  return readChecked('canvas_doc_identity_intents', id, () =>
    executor
      .select()
      .from(canvasDocIdentityIntents)
      .where(eq(canvasDocIdentityIntents.intentId, id))
      .get()
  );
}

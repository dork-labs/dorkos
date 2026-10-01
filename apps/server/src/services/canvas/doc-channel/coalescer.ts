import type { SynchronousResult } from './store-transaction.js';
/** Compact, sequence-ordered pending batches; admission remains an external transaction port. */
import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  inArray,
  canvasDocBatches,
  canvasDocDeliveries,
  type DbTransaction,
} from '@dorkos/db';
import type { CanvasChannelDocEventsContext } from '@dorkos/shared/canvas-channel-schemas';
import {
  DocChannelCorruptionError,
  DocChannelStore,
  type DocBatchRow,
  type DocEventRow,
} from './store.js';
import type { DocIngestAccess, DocRouteDecision } from './ingest-types.js';
import { DocIngestRefusal } from './ingest-types.js';
import { docEventsPromptBytes, DOC_EVENTS_PROMPT_BYTES } from './prompt.js';

/** Renderer input assembled only from stored events and server-derived metadata. */
export function batchContext(
  batch: DocBatchRow,
  events: DocEventRow[],
  documentLabel: string
): CanvasChannelDocEventsContext {
  return {
    documentId: batch.documentId,
    documentLabel,
    scope: batch.scope,
    batchId: batch.batchId,
    routeId: batch.routeId,
    grantId: batch.grantId,
    events: events.map((event) => ({
      id: event.eventId,
      type: event.type,
      payload: event.payload as CanvasChannelDocEventsContext['events'][number]['payload'],
      docSeq: event.docSeq,
    })),
  };
}

/** Add input while preserving the first deadline and explicitly settling replaceable inputs. */
export function queueInput(
  store: DocChannelStore,
  tx: DbTransaction,
  access: DocIngestAccess,
  decision: DocRouteDecision,
  event: DocEventRow,
  now: string
): void {
  const { route, grantId, grantRevision } = decision;
  if (!grantId || !grantRevision || route.turn.mode === 'none')
    throw new Error('Queue requires verified turn authority.');
  const pending = tx
    .select({ batchId: canvasDocBatches.batchId })
    .from(canvasDocBatches)
    .where(
      and(
        eq(canvasDocBatches.documentId, access.documentId),
        eq(canvasDocBatches.routeId, route.id),
        inArray(canvasDocBatches.status, ['pending', 'waiting'])
      )
    )
    .get();
  const batch = pending ? store.getBatch(pending.batchId, tx)! : undefined;
  if (
    batch &&
    (batch.grantId !== grantId ||
      batch.grantRevision !== grantRevision ||
      batch.scope !== access.scope)
  ) {
    store.insertDelivery(
      {
        documentId: event.documentId,
        eventId: event.eventId,
        routeId: route.id,
        status: 'saved',
        reason: 'route_generation_changed',
        updatedAt: now,
      },
      tx
    );
    return;
  }
  const batchId = batch?.batchId ?? randomUUID();
  let ids = batch?.inputEventIds ?? [];
  // Type participates in identity: a comment can never replace a checkbox sharing its key.
  if (event.coalesceKey && route.coalescibleTypes?.includes(event.type)) {
    ids = ids.filter((id) => {
      const prior = store.getEvent(event.documentId, id, tx)!;
      if (prior.type !== event.type || prior.coalesceKey !== event.coalesceKey) return true;
      if (
        !store.updateDelivery(
          {
            documentId: event.documentId,
            eventId: id,
            routeId: route.id,
            expectedStatus: batch!.status === 'waiting' ? 'waiting' : 'pending',
            changes: { status: 'superseded', reason: 'replaced_before_admission', updatedAt: now },
          },
          tx
        )
      )
        throw new Error('Pending delivery changed while coalescing.');
      return false;
    });
  }
  ids = [...ids, event.eventId];
  if (batch) {
    if (
      !store.updatePendingBatch(
        {
          batchId,
          generation: batch.generation,
          status: batch.status as 'pending' | 'waiting',
          inputEventIds: ids,
          effectivePayload: { eventIds: ids },
          updatedAt: now,
        },
        tx
      )
    )
      throw new Error('Pending batch changed.');
  } else {
    const due = Date.parse(now) + (route.turn.mode === 'coalesce' ? route.turn.windowMs : 0);
    if (!Number.isFinite(due) || due > 8640000000000000)
      throw new DocIngestRefusal('INVALID_ROUTE_DEADLINE', 422);
    store.insertBatch(
      {
        batchId,
        documentId: event.documentId,
        scope: access.scope,
        routeId: route.id,
        grantId,
        grantRevision,
        generation: randomUUID(),
        inputEventIds: ids,
        effectivePayload: { eventIds: ids },
        dueAt: new Date(due).toISOString(),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
      tx
    );
  }
  store.insertDelivery(
    {
      documentId: event.documentId,
      eventId: event.eventId,
      routeId: route.id,
      batchId,
      status: batch?.status === 'waiting' ? 'waiting' : 'pending',
      updatedAt: now,
    },
    tx
  );
}

/** Exact immutable inputs offered to an admission owner, excluding superseded receipts. */
export interface DocBatchSlice {
  batch: DocBatchRow;
  context: CanvasChannelDocEventsContext;
  overflowIds: string[];
}

/** Select at most 100 originals and the exact rendered byte budget; no input is silently dropped. */
export function selectBatchSlice(
  store: DocChannelStore,
  tx: DbTransaction,
  batch: DocBatchRow,
  maxBatch: number,
  documentLabel: string
): DocBatchSlice {
  if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 100)
    throw new RangeError('Invalid batch maximum.');
  if (!['pending', 'waiting'].includes(batch.status))
    throw new Error('Only pending inputs can be selected.');
  if (new Set(batch.inputEventIds).size !== batch.inputEventIds.length)
    throw new DocChannelCorruptionError('canvas_doc_batches', batch.batchId);
  const selected: DocEventRow[] = [];
  const inputs = batch.inputEventIds
    .map((id) => {
      const event = store.getEvent(batch.documentId, id, tx);
      if (!event || event.payloadPrunedAt !== null)
        throw new DocChannelCorruptionError('canvas_doc_batches', batch.batchId);
      return event;
    })
    .sort((a, b) => a.docSeq - b.docSeq);
  for (const event of inputs) {
    if (
      selected.length === maxBatch ||
      docEventsPromptBytes(batchContext(batch, [...selected, event], documentLabel)) >
        DOC_EVENTS_PROMPT_BYTES
    )
      break;
    selected.push(event);
  }
  if (!selected.length) throw new DocIngestRefusal('DOC_EVENT_CONTEXT_TOO_LARGE', 413);
  return {
    batch: {
      ...batch,
      inputEventIds: selected.map((event) => event.eventId),
      effectivePayload: { eventIds: selected.map((event) => event.eventId) },
    },
    context: batchContext(batch, selected, documentLabel),
    overflowIds: inputs.slice(selected.length).map((event) => event.eventId),
  };
}

/** Split atomically with external admission; the callback must move the selected batch out of the pending slot. */
export function admitBatchSlice<T>(
  store: DocChannelStore,
  batchId: string,
  maxBatch: number,
  documentLabel: string,
  now: string,
  admit: (tx: DbTransaction, slice: DocBatchSlice) => T & SynchronousResult<T>
): T {
  return store.transaction<T>((tx) => {
    const original = store.getBatch(batchId, tx);
    if (!original) throw new Error('Missing pending batch.');
    const slice = selectBatchSlice(store, tx, original, maxBatch, documentLabel);
    if (
      !store.updatePendingBatch(
        {
          batchId,
          generation: original.generation,
          status: original.status as 'pending' | 'waiting',
          inputEventIds: slice.batch.inputEventIds,
          effectivePayload: slice.batch.effectivePayload,
          updatedAt: now,
        },
        tx
      )
    )
      throw new Error('Pending batch changed.');
    const result = admit(tx, slice);
    const accepted = store.getBatch(batchId, tx)!;
    if (
      accepted.generation !== original.generation ||
      JSON.stringify(accepted.inputEventIds) !== JSON.stringify(slice.batch.inputEventIds)
    )
      throw new Error('Admission changed original input identity.');
    if (['pending', 'waiting'].includes(accepted.status))
      throw new Error('Admission did not release the pending slot.');
    if (slice.overflowIds.length) {
      const overflowId = randomUUID();
      store.insertBatch(
        {
          ...original,
          scope: accepted.scope,
          batchId: overflowId,
          generation: randomUUID(),
          inputEventIds: slice.overflowIds,
          effectivePayload: { eventIds: slice.overflowIds },
          attempt: 0,
          leaseUntil: null,
          relayMessageId: null,
          turnId: null,
          admissionReceiptId: null,
          errorCode: null,
          createdAt: now,
          updatedAt: now,
        },
        tx
      );
      tx.update(canvasDocDeliveries)
        .set({ batchId: overflowId })
        .where(
          and(
            eq(canvasDocDeliveries.documentId, original.documentId),
            eq(canvasDocDeliveries.routeId, original.routeId),
            eq(canvasDocDeliveries.batchId, batchId),
            inArray(canvasDocDeliveries.eventId, slice.overflowIds)
          )
        )
        .run();
    }
    return result;
  });
}

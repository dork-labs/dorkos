/** Fixed original outbox SQL auditing; no callbacks, mutation or transferable permit. */
import {
  eq,
  sql,
  canvasDocEvents,
  canvasDocDeliveries,
  canvasDocBatches,
  type DbTransaction,
} from '@dorkos/db';
import { CanvasChannelJsonValueSchema } from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import { envelopeIdentity } from '../envelope.js';
import { readOriginalCheckboxQueueIdentity } from '../coalescer.js';
import type { DocChannelStore, DocEventRow, DocBatchRow } from '../store.js';
import type { CheckboxReservationPolicy } from './reservation-policy-census.js';
import type { VerifiedCheckboxProjection } from './completion.js';
import { validateCheckboxEvidence } from './checkbox-evidence.js';
function same(a: unknown, b: unknown): boolean {
  return hashApprovalInput(a) === hashApprovalInput(b);
}
/** Fixed SQL projection validator; it cannot register or grant reservation authority. */
export function auditOriginalCheckboxOutbox(
  tx: DbTransaction,
  obligation: {
    event: DocEventRow;
    policy: CheckboxReservationPolicy;
    projection: VerifiedCheckboxProjection;
    priorBatch: DocBatchRow | null;
  },
  store: DocChannelStore
): void {
  const { event, policy, projection, priorBatch } = obligation;
  const deliveries = tx
    .select()
    .from(canvasDocDeliveries)
    .where(
      sql`${canvasDocDeliveries.documentId}=${event.documentId} AND ${canvasDocDeliveries.eventId}=${event.eventId}`
    )
    .all();
  const delivery = deliveries[0];
  if (
    deliveries.length !== 1 ||
    !delivery ||
    delivery.routeId !== policy.route.id ||
    delivery.updatedAt !== event.receivedAt
  )
    throw new Error('Checkbox original durable completion outbox changed.');
  if (!policy.pending) {
    if (delivery.status !== 'routed' || delivery.reason !== 'no_turn' || delivery.batchId !== null)
      throw new Error('Checkbox original no-turn outbox changed.');
  } else {
    const batch = delivery.batchId
      ? tx
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.batchId, delivery.batchId))
          .get()
      : undefined;
    const identity = readOriginalCheckboxQueueIdentity(store, tx, event);
    if (delivery.batchId !== identity.batchId || batch?.generation !== identity.generation)
      throw new Error('Checkbox original created batch identity changed.');
    if (
      !batch ||
      !['pending', 'waiting'].includes(delivery.status) ||
      batch.status !== delivery.status ||
      delivery.reason !== null ||
      batch.documentId !== event.documentId ||
      batch.scope !== policy.scope ||
      batch.routeId !== policy.route.id ||
      batch.grantId !== projection.intent.grantId ||
      batch.grantRevision !== validateCheckboxEvidence(projection.intent).authority.grantRevision ||
      !batch.inputEventIds.includes(event.eventId)
    )
      throw new Error('Checkbox original correlated outbox changed.');
    const expectedIds = [...(priorBatch?.inputEventIds ?? []), event.eventId];
    if (
      !same(batch.inputEventIds, expectedIds) ||
      !same(batch.effectivePayload, { eventIds: expectedIds }) ||
      batch.updatedAt !== event.receivedAt
    )
      throw new Error('Checkbox original batch inputs changed.');
    if (
      priorBatch &&
      !same(
        {
          ...batch,
          inputEventIds: priorBatch.inputEventIds,
          effectivePayload: priorBatch.effectivePayload,
          updatedAt: priorBatch.updatedAt,
        },
        priorBatch
      )
    )
      throw new Error('Checkbox original batch identity changed.');
    if (!priorBatch) {
      const dueAt = new Date(
        Date.parse(event.receivedAt) +
          (policy.route.turn.mode === 'coalesce' ? policy.route.turn.windowMs : 0)
      ).toISOString();
      if (
        batch.status !== 'pending' ||
        batch.createdAt !== event.receivedAt ||
        batch.dueAt !== dueAt ||
        batch.attempt !== 0 ||
        batch.admissionReceiptId !== null ||
        batch.relayMessageId !== null ||
        batch.turnId !== null ||
        batch.waitingWarningAt !== null ||
        batch.leaseUntil !== null ||
        batch.errorCode !== null
      )
        throw new Error('Checkbox new original batch identity changed.');
    }
  }
  const status = tx
    .select()
    .from(canvasDocEvents)
    .where(
      sql`${canvasDocEvents.documentId}=${event.documentId} AND ${canvasDocEvents.docSeq}=${event.docSeq + 1}`
    )
    .get();
  const payload = {
    eventId: event.eventId,
    routeId: delivery.routeId,
    status: delivery.status,
    ...(delivery.batchId !== null ? { batchId: delivery.batchId } : {}),
    ...(delivery.reason !== null ? { reason: delivery.reason } : {}),
  };
  if (
    !status ||
    status.direction !== 'system' ||
    status.type !== 'event.status' ||
    !same(status.payload, payload) ||
    !same(status.provenance, { source: 'doc-channel-service' }) ||
    status.receivedAt !== event.receivedAt ||
    status.payloadPrunedAt !== null ||
    status.coalesceKey !== null ||
    status.clientTs !== null
  )
    throw new Error('Checkbox original initial status changed.');
  const identity = envelopeIdentity({
    v: 1,
    id: status.eventId,
    type: status.type,
    payload: CanvasChannelJsonValueSchema.parse(status.payload),
  });
  if (status.envelopeHash !== identity.hash || status.envelopeBytes !== identity.bytes)
    throw new Error('Checkbox initial status envelope changed.');
}

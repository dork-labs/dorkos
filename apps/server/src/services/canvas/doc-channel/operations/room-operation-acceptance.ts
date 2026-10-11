import { readOriginalRoomRowIntention } from '../current/current-operation-intentions.js';
import { readOriginalRoomDispatchFacts } from '../../../rooms/service/room-core.js';
import { randomUUID } from 'node:crypto';
import { sql, eq, and, canvasDocuments, canvasDocDeliveries, type DbTransaction } from '@dorkos/db';
import { readRoomStoreGrantedDocTargetBinding } from '../../../rooms/room-store.js';
import {
  captureNativePrincipalTime,
  readCurrentNativePrincipalSource,
} from '../../../connectors/principal/runtime-principal-service.js';
import { readCurrentDocIngressInput, requireCurrentDocEngineOrigin } from '../authorization.js';
import { readCurrentOriginalRoomGrantSource } from '../grant-revalidation.js';
import { readCurrentStoreGetBatch } from '../current/current-operation-row-audit.js';
import {
  readDocEventRow,
  resolveCheckboxSqlScope,
} from '../writes/reservations/reservation-policy-census.js';
import { withCheckboxReadOnlyGate } from '../writes/authority/authority-snapshot.js';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../store.js';
import type { DocChannelGrants } from '../grants.js';
import type { OriginalRoomRouteDraft as RouteDraft } from '../current/current-operation-types.js';
import {
  copyCurrentDocData,
  sameOriginalRoomSerializedGrantData,
} from '../current/current-operation-data.js';
import { readOriginalRoomOperationView } from './room-current-operation.js';

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function prepare(
  operationOwner: object,
  store: DocChannelStore,
  grants: DocChannelGrants,
  tx: DbTransaction
): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  requireCurrentDocEngineOrigin(facet.authorization, facet.engine, facet.db);
  requireDocChannelStoreDatabase(store, facet.db);
  if (facet.drafts.has(tx)) throw new Error('Original Room source preparation is one-use.');
  const input = readCurrentDocIngressInput(facet.authorization, store, tx);
  const routes = new Map<string, RouteDraft>();
  facet.drafts.set(tx, { store, eventId: input.event.id, routes });
  for (const decision of input.access?.routes ?? []) {
    if (decision.reason || decision.route.to !== 'room:self' || decision.route.turn.mode === 'none')
      continue;
    // The actual captured ingress actor is the producer; a destination turn never substitutes.
    const tokenProducer = input.tokenScope
      ? facet.engine.captureRoomTokenProducer(store, tx)
      : undefined;
    const operator =
      input.actor?.principal.claims.kind === 'operator'
        ? facet.engine.captureRoomOperatorProducer(store, tx)
        : undefined;
    if (!operator && !tokenProducer && input.actor?.principal.claims.kind !== 'runtime')
      throw new Error('Original Room producer is unsupported.');
    const time =
      operator || tokenProducer
        ? undefined
        : withCheckboxReadOnlyGate(facet.db, () =>
            captureNativePrincipalTime(facet.principals, facet.db, input.actor!.principal)
          );
    if (!operator && !tokenProducer && time === undefined)
      throw new Error('Original runtime principal time unavailable.');
    const producerSource =
      operator || tokenProducer || time === undefined
        ? undefined
        : readCurrentNativePrincipalSource(
            facet.principals,
            facet.db,
            input.actor!.principal,
            tx,
            time
          );
    if (!operator && !tokenProducer && !producerSource)
      throw new Error('Room source requires its genuine live producer acquisition.');
    const producer = tokenProducer ?? operator ?? producerSource!.binding;
    const roomCustody = producerSource?.roomCustody;
    const original = readCurrentOriginalRoomGrantSource(
      grants,
      store,
      facet.authorization,
      tx,
      decision.route.id
    );
    const grant = original.grant;
    const serializedGrant = tx.get<{ route: string; limits: string; evidence: string }>(sql`
        SELECT normalized_route AS route,limits AS limits,approval_evidence AS evidence
        FROM canvas_doc_grants WHERE grant_id=${grant.grantId}`);
    if (!sameOriginalRoomSerializedGrantData(serializedGrant, grant))
      throw new Error('Original Room serialized grant differs from its private claims.');
    const canonical = resolveCheckboxSqlScope(tx, `session:${grant.targetSessionId}`);
    if (!canonical.startsWith('session:')) throw new Error('Room target session is unavailable.');
    const target = readRoomStoreGrantedDocTargetBinding(
      facet.roomStore,
      facet.db,
      input.scope.slice('room:'.length),
      grant.targetAgentId!,
      canonical.slice('session:'.length),
      grant.targetRuntime!
    );
    if (!target) throw new Error('Room target lacks its actual stored membership/session binding.');
    const physical = tx
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, input.documentId))
      .get();
    if (!physical || physical.scope !== input.scope)
      throw new Error('Original Room physical source changed.');
    const producerRoomFacts = roomCustody
      ? readOriginalRoomDispatchFacts(roomCustody, facet.db)
      : undefined;
    if (roomCustody && !producerRoomFacts)
      throw new Error(
        'Original Room producer lost its actual request/root custody before acceptance.'
      );
    const before = readOriginalRoomRowIntention(
      tx,
      input.documentId,
      grant.grantId,
      original.approval.id
    );
    routes.set(decision.route.id, {
      before,
      producerRoomFacts: producerRoomFacts ? copyCurrentDocData(producerRoomFacts) : undefined,
      roomCustody,
      original,
      serializedGrant: copyCurrentDocData(serializedGrant),
      physical: copyCurrentDocData(physical),
      producer: copyCurrentDocData(producer),
      target: copyCurrentDocData(target),
      admissionId: randomUUID(),
    });
  }
}

/** Capture replay custody from the original expired rows before any replay effect. */
export function prepareReplay(
  operationOwner: object,
  store: DocChannelStore,
  grants: DocChannelGrants,
  tx: DbTransaction,
  previousBatchId: string,
  now: string
): import('../store.js').DocBatchRow {
  const facet = readOriginalRoomOperationView(operationOwner);
  const input = readCurrentDocIngressInput(facet.authorization, store, tx);
  if (
    !input.scope.startsWith('room:') ||
    input.actor?.principal.claims.kind !== 'operator' ||
    input.now !== now
  )
    throw new Error('Room replay requires its original current operator and clock.');
  const old = readCurrentStoreGetBatch(tx, previousBatchId);
  if (
    !old ||
    old.documentId !== input.documentId ||
    old.scope !== input.scope ||
    old.status !== 'expired' ||
    old.errorCode === 'manual_replay_consumed' ||
    old.inputEventIds.length < 1 ||
    old.inputEventIds.length > 400 ||
    new Set(old.inputEventIds).size !== old.inputEventIds.length ||
    old.inputEventIds[0] !== input.event.id ||
    old.admissionReceiptId !== null ||
    old.turnId !== null ||
    old.relayMessageId !== null ||
    old.leaseUntil !== null ||
    old.deliveryKind === 'room_app_event' ||
    old.roomAdmissionId !== null ||
    old.roomSourceAttempt !== null ||
    old.roomSourceJson !== null ||
    old.roomSourceHash !== null ||
    tx.get(
      sql`SELECT 1 FROM room_doc_admissions WHERE document_id=${input.documentId} AND batch_id=${old.batchId} LIMIT 1`
    ) ||
    tx.get(
      sql`SELECT 1 FROM session_message_acceptance_receipts WHERE source_kind='document_event_batch' AND source_id=${old.batchId} LIMIT 1`
    )
  )
    throw new Error('Original Room replay source is unavailable.');
  const previousKey = `${old.batchId}:${old.generation}`;
  if (
    facet.unavailable.has(previousKey) ||
    facet.frozen.has(previousKey) ||
    facet.preparing.has(previousKey) ||
    facet.preparationUnknown.has(previousKey)
  )
    throw new Error('Original Room replay source is already acquired or uncertain.');
  const deliveries = tx
    .select()
    .from(canvasDocDeliveries)
    .where(
      and(
        eq(canvasDocDeliveries.documentId, input.documentId),
        eq(canvasDocDeliveries.batchId, old.batchId)
      )
    )
    .orderBy(canvasDocDeliveries.eventId, canvasDocDeliveries.routeId)
    .limit(401)
    .all();
  if (
    deliveries.length !== old.inputEventIds.length ||
    deliveries.some(
      (row) =>
        row.routeId !== old.routeId ||
        !old.inputEventIds.includes(row.eventId) ||
        row.status !== 'expired' ||
        row.turnId !== null ||
        row.roomAdmissionId !== null ||
        row.deliveryKind === 'room_app_event' ||
        row.ackOutcome !== null ||
        row.ackEvidence !== null ||
        row.acknowledgedAt !== null ||
        row.acknowledgedBy !== null
    )
  )
    throw new Error('Original Room replay deliveries are unavailable.');
  facet.prepare(store, grants, tx);
  const draft = facet.drafts.get(tx)!;
  const route = draft.routes.get(old.routeId);
  if (draft.routes.size !== 1 || !route)
    throw new Error('Room replay requires exactly its selected original route.');
  const batch: import('../store.js').DocBatchRow = {
    batchId: randomUUID(),
    documentId: input.documentId,
    scope: input.scope,
    routeId: old.routeId,
    grantId: route.original.grant.grantId,
    grantRevision: route.original.grant.revision,
    generation: randomUUID(),
    inputEventIds: [...old.inputEventIds],
    effectivePayload: { eventIds: [...old.inputEventIds] },
    dueAt: now,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    attempt: 0,
    leaseUntil: null,
    waitingWarningAt: null,
    relayMessageId: null,
    turnId: null,
    admissionReceiptId: null,
    deliveryKind: null,
    roomAdmissionId: null,
    roomSourceAttempt: null,
    roomSourceJson: null,
    roomSourceHash: null,
    errorCode: null,
  };
  const inputs = old.inputEventIds.map((id) => {
    const original = readDocEventRow(tx, input.documentId, id);
    const delivery = deliveries.find((row) => row.eventId === id)!;
    if (!original || original.direction !== 'upstream' || original.payloadPrunedAt !== null)
      throw new Error('Original Room replay input is unavailable.');
    return {
      original,
      delivery: {
        ...delivery,
        batchId: batch.batchId,
        status: 'pending' as const,
        reason: null,
        updatedAt: now,
      },
    };
  });
  draft.replay = {
    previousKey,
    previousPending: facet.pending.get(previousKey),
    intention: copyCurrentDocData({ batch, delivery: inputs[0]!.delivery, inputs }),
  };
  return copyCurrentDocData(batch);
}

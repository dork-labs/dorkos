import { buildOriginalRoomPendingSource } from '../replay.js';
import { readOriginalRoomRowIntention } from '../current/current-operation-intentions.js';
import { sql, eq, and, canvasDocDeliveries, type DbTransaction } from '@dorkos/db';
import { readRoomStoreGrantedDocTargetBinding } from '../../../rooms/room-store.js';
import { readCurrentDocIngressInput } from '../authorization.js';
import { readCurrentOriginalRoomGrantSource } from '../grant-revalidation.js';
import { readCurrentDocQueueAudit } from '../coalescer.js';
import { protectedCapacityQuery, type DocIngestLimits } from '../current/accounting.js';
import { scanCheckboxReservationPolicies } from '../writes/reservations/reservation-policy-census.js';
import { DocIngestRefusal } from '../ingest-data/ingest-types.js';
import { readCurrentStoreGetBatch } from '../current/current-operation-row-audit.js';
import { readDocEventRow } from '../writes/reservations/reservation-policy-census.js';
import { type DocChannelStore } from '../store.js';
import type { DocChannelGrants } from '../grants.js';
import type { PendingRoomSource as PendingSource } from '../current/current-operation-types.js';
import {
  sameCurrentDocData,
  copyOriginalRoomSerializedInputData,
} from '../current/current-operation-data.js';
import { readOriginalRoomOperationView } from './room-current-operation.js';

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function seal(
  operationOwner: object,
  store: DocChannelStore,
  tx: DbTransaction,
  limits: DocIngestLimits
): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  const input = readCurrentDocIngressInput(facet.authorization, store, tx);
  const draft = facet.drafts.get(tx);
  if (!draft || draft.store !== store || draft.eventId !== input.event.id || draft.sealed)
    throw new Error('Original Room source transaction is foreign or already sealed.');
  const event = readDocEventRow(tx, input.documentId, input.event.id);
  if (!event) throw new Error('Original Room input is absent.');
  const queue = draft.replay
    ? [draft.replay.intention]
    : readCurrentDocQueueAudit(store, tx, event);
  if (draft.replay) {
    const intended = draft.replay.intention;
    if (
      !intended.batch ||
      !intended.inputs ||
      !sameCurrentDocData(intended.batch, readCurrentStoreGetBatch(tx, intended.batch.batchId))
    )
      throw new Error('Original Room replay batch differs from its pre-effect source.');
    const actual = tx
      .select()
      .from(canvasDocDeliveries)
      .where(
        and(
          eq(canvasDocDeliveries.documentId, input.documentId),
          eq(canvasDocDeliveries.batchId, intended.batch.batchId)
        )
      )
      .orderBy(canvasDocDeliveries.eventId, canvasDocDeliveries.routeId)
      .limit(401)
      .all();
    const expected = intended.inputs
      .map((pair) => pair.delivery)
      .sort((a, b) => a.eventId.localeCompare(b.eventId) || a.routeId.localeCompare(b.routeId));
    if (
      !sameCurrentDocData(actual, expected) ||
      intended.inputs.some(
        (pair) =>
          !sameCurrentDocData(
            pair.original,
            readDocEventRow(tx, input.documentId, pair.original.eventId)
          )
      )
    )
      throw new Error('Original Room replay rows differ from their pre-effect source.');
  }
  const prepared: PendingSource[] = [];
  for (const [routeId, route] of draft.routes) {
    const intended = queue.find((candidate) => candidate.delivery.routeId === routeId);
    if (!intended?.batch || !intended.inputs) continue; // Saved/refused input is not a Room acceptance.
    const batch = intended.batch;
    const key = `${batch.batchId}:${batch.generation}`;
    if (facet.unavailable.has(key)) throw new Error('Original Room acceptance is uncertain.');
    const previous = facet.pending.get(key);
    const priorIds = intended.inputs
      .filter((pair) => pair.original.eventId !== event.eventId)
      .map((pair) => pair.original.eventId);
    if (
      !draft.replay &&
      priorIds.length &&
      (!previous ||
        priorIds.some((id) => !previous.source.inputs.some((old) => old.eventId === id)))
    )
      throw new Error('Existing Room batch lacks original committed producer custody.');
    if (
      previous &&
      (previous.roomCustody !== route.roomCustody ||
        !sameCurrentDocData(previous.before, route.before) ||
        !sameCurrentDocData(previous.producerRoomFacts ?? null, route.producerRoomFacts ?? null) ||
        !sameCurrentDocData(previous.producer, route.producer) ||
        previous.source.grantId !== route.original.grant.grantId ||
        previous.source.grantRevision !== route.original.grant.revision ||
        previous.dueAt !== batch.dueAt)
    )
      throw new Error('Original Room generation/producer/deadline changed.');
    const inputs = intended.inputs.map(({ original, delivery }) => {
      const raw = tx.get<{ payload: string; provenance: string; evidence: string | null }>(sql`
          SELECT e.payload AS payload,e.provenance AS provenance,d.ack_evidence AS evidence
          FROM canvas_doc_events e JOIN canvas_doc_deliveries d
          ON d.document_id=e.document_id AND d.event_id=e.event_id
          WHERE e.document_id=${batch.documentId} AND e.event_id=${original.eventId} AND d.route_id=${routeId}`);
      return copyOriginalRoomSerializedInputData(raw, original, delivery);
    });
    const rawBatch = tx.get<{ ids: string; payload: string }>(sql`SELECT input_event_ids AS ids,
        effective_payload AS payload FROM canvas_doc_batches WHERE batch_id=${batch.batchId}`);
    if (
      !rawBatch ||
      !sameCurrentDocData(JSON.parse(rawBatch.ids), batch.inputEventIds) ||
      !sameCurrentDocData(JSON.parse(rawBatch.payload), batch.effectivePayload)
    )
      throw new Error('Room serialized batch differs from its pre-effect intention.');
    const pending = buildOriginalRoomPendingSource(
      route,
      batch,
      previous,
      intended.inputs,
      inputs,
      rawBatch,
      routeId
    );
    if (pending.source.originalSourceJson.length > 1_048_576)
      throw new Error('Original pending Room capsule exceeds the native source bound.');
    const old = tx.get<Record<string, unknown>>(sql`SELECT * FROM canvas_doc_room_pending_sources
        WHERE document_id=${batch.documentId} AND batch_id=${batch.batchId} AND generation=${batch.generation}`);
    if (previous ? !sameCurrentDocData(old, facet.pendingCapsule(previous)) : old !== undefined)
      throw new Error('Original pending Room capsule differs from committed custody.');
    const changesBefore = tx.get<{ total: number }>(sql`SELECT total_changes() AS total`)!.total;
    const changed = previous
      ? tx.run(sql`UPDATE canvas_doc_room_pending_sources SET source_json=${pending.source.originalSourceJson},
            source_hash=${pending.source.originalSourceHash},updated_at=${pending.source.originalUpdatedAt}
            WHERE document_id=${batch.documentId} AND batch_id=${batch.batchId} AND generation=${batch.generation}
            AND source_json=${previous.source.originalSourceJson} AND source_hash=${previous.source.originalSourceHash}
            AND due_at=${previous.dueAt} AND updated_at=${previous.source.originalUpdatedAt}`)
      : tx.run(sql`INSERT INTO canvas_doc_room_pending_sources
            (document_id,batch_id,generation,source_json,source_hash,due_at,updated_at) VALUES
            (${batch.documentId},${batch.batchId},${batch.generation},${pending.source.originalSourceJson},
             ${pending.source.originalSourceHash},${pending.dueAt},${pending.source.originalUpdatedAt})`);
    const changesAfter = tx.get<{ total: number }>(sql`SELECT total_changes() AS total`)!.total;
    if (
      changed.changes !== 1 ||
      !Number.isSafeInteger(changesBefore) ||
      changesAfter - changesBefore !== 1 ||
      !sameCurrentDocData(
        facet.pendingCapsule(pending),
        tx.get(sql`SELECT * FROM canvas_doc_room_pending_sources
            WHERE document_id=${batch.documentId} AND batch_id=${batch.batchId} AND generation=${batch.generation}`)
      )
    )
      throw new Error('Original pending Room capsule write changed outside its intended row.');
    prepared.push(pending);
  }
  facet.pendingLimits.set(tx, Object.freeze({ ...limits }));
  facet.checkPendingCapacity(tx, input.documentId, limits);
  draft.sealed = Object.freeze(prepared);
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function checkPendingCapacity(
  operationOwner: object,
  tx: DbTransaction,
  documentId: string,
  limits: DocIngestLimits
): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  const usage = tx.get<{ count: number; bytes: number }>(protectedCapacityQuery(documentId))!;
  const installation = tx.get<{ bytes: number }>(protectedCapacityQuery())!;
  const reservations = scanCheckboxReservationPolicies(tx, { documentId });
  if (
    usage.count + reservations.document.originals > limits.pendingEvents ||
    usage.bytes + reservations.document.bytes > limits.pendingBytes ||
    installation.bytes + reservations.installation.bytes > limits.installationPendingBytes
  )
    throw new DocIngestRefusal('DOC_EVENT_BACKLOG_FULL', 429, 60);
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function pendingCapsule(
  operationOwner: object,
  pending: PendingSource
): {
  document_id: string;
  batch_id: string;
  generation: string;
  source_json: string;
  source_hash: string;
  due_at: string;
  updated_at: string;
} {
  const facet = readOriginalRoomOperationView(operationOwner);
  return {
    document_id: pending.source.documentId,
    batch_id: pending.source.batchId,
    generation: pending.source.generation,
    source_json: pending.source.originalSourceJson,
    source_hash: pending.source.originalSourceHash,
    due_at: pending.dueAt,
    updated_at: pending.source.originalUpdatedAt,
  };
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function audit(
  operationOwner: object,
  store: DocChannelStore,
  grants: DocChannelGrants,
  tx: DbTransaction
): void {
  const facet = readOriginalRoomOperationView(operationOwner);
  const input = readCurrentDocIngressInput(facet.authorization, store, tx);
  const draft = facet.drafts.get(tx);
  if (!draft?.sealed || draft.store !== store || draft.eventId !== input.event.id)
    throw new Error('Original Room exit lacks its sealed scope.');
  for (const pending of draft.sealed) {
    const source = pending.source;
    if (
      !sameCurrentDocData(
        facet.pendingCapsule(pending),
        tx.get(sql`SELECT * FROM canvas_doc_room_pending_sources
          WHERE document_id=${source.documentId} AND batch_id=${source.batchId} AND generation=${source.generation}`)
      )
    )
      throw new Error('Original pending Room capsule changed before commit.');
  }
  // Fixed same-Db SQL only, after all configured callbacks and before outer commit.
  for (const [routeId, route] of draft.routes) {
    const original = readCurrentOriginalRoomGrantSource(
      grants,
      store,
      facet.authorization,
      tx,
      routeId
    );
    const target = readRoomStoreGrantedDocTargetBinding(
      facet.roomStore,
      facet.db,
      route.target.roomId,
      route.target.targetAgentId,
      route.target.targetSessionId,
      route.target.targetRuntime
    );
    if (
      'kind' in route.producer &&
      !sameCurrentDocData(
        route.producer,
        route.producer.kind === 'doc_token'
          ? facet.engine.captureRoomTokenProducer(store, tx)
          : facet.engine.captureRoomOperatorProducer(store, tx)
      )
    )
      throw new Error('Original operator producer changed before commit.');
    const before = readOriginalRoomRowIntention(
      tx,
      input.documentId,
      original.grant.grantId,
      original.approval.id
    );
    if (
      !sameCurrentDocData(route.before, before) ||
      !sameCurrentDocData(route.original, original) ||
      !sameCurrentDocData(route.target, target)
    )
      throw new Error('Original Room grant/approval/target changed before commit.');
  }
  const limits = facet.pendingLimits.get(tx);
  if (!limits) throw new Error('Original pending Room limits are absent.');
  facet.checkPendingCapacity(tx, input.documentId, limits);
}

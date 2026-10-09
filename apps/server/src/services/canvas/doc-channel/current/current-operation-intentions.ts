import {
  canvasDocuments,
  canvasDocChannels,
  canvasDocBatches,
  and,
  isNull,
  eq,
  sql,
  canvasDocDeliveries,
  type DbTransaction,
} from '@dorkos/db';

import {
  matchesCanvasChannelEvent,
  type CanvasChannelDocEventsContext,
  CANVAS_CHANNEL_STATE_BYTES,
  CANVAS_CHANNEL_ENVELOPE_BYTES,
  CanvasChannelStateSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  copyCurrentDocData,
  captureCurrentDocConfiguration,
  sameCurrentDocData,
} from './current-operation-data.js';
import { readDocEventRow } from '../writes/reservations/reservation-policy-census.js';
import { type readCurrentDocIngressInput } from '../authorization.js';
export interface CurrentIngestIntention {
  changesBefore: number;
  accountingWrites: number;
  documentId: string;
  eventId: string;
  original?: import('../store.js').DocEventRow;
  deliveries: import('../store.js').DocDeliveryRow[];
  routes: string[];
  duplicate: boolean;
  checkbox?: {
    original: import('../store.js').DocWriteIntentRow;
    receipt?: import('@dorkos/shared/canvas-channel-schemas').IngestReceipt;
    completed: boolean;
  };
}
/** Full fresh readonly before-effect capture; no scope registration, caller count or write capability. */
export function captureCurrentIngestIntention(
  tx: DbTransaction,
  input: ReturnType<typeof readCurrentDocIngressInput>
): CurrentIngestIntention {
  const original = readDocEventRow(tx, input.documentId, input.event.id);
  const routes =
    input.access?.routes
      .filter(({ route }) => matchesCanvasChannelEvent(route.on, input.event.type))
      .map(({ route }) => route.id) ?? [];
  if (new Set(routes).size !== routes.length || routes.length > 16)
    throw new Error('Current route intentions are invalid.');
  // Set once BEFORE original counter/INSERT and every route effect. Never learn intentions from trigger-mutated rows.
  const deliveries = original
    ? tx
        .select()
        .from(canvasDocDeliveries)
        .where(
          and(
            eq(canvasDocDeliveries.documentId, input.documentId),
            eq(canvasDocDeliveries.eventId, input.event.id)
          )
        )
        .all()
    : [];
  const changesBefore = tx.get<{ total: number }>(sql`SELECT total_changes() AS total`)!.total;
  const accountingWrites = original
    ? 0
    : tx.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM canvas_doc_events WHERE envelope_bytes=0 AND payload_pruned_at IS NULL`
      )!.count;
  if (
    !Number.isSafeInteger(changesBefore) ||
    changesBefore < 0 ||
    !Number.isSafeInteger(accountingWrites) ||
    accountingWrites < 0
  )
    throw new Error('Current native write census is unavailable.');
  return {
    changesBefore,
    accountingWrites,
    documentId: input.documentId,
    eventId: input.event.id,
    ...(original ? { original: copyCurrentDocData(original) } : {}),
    deliveries: [...copyCurrentDocData(deliveries)],
    routes: [...routes],
    duplicate: !!original,
  };
}

import { type DocEventCondition } from './current-operation-types.js';

import { DocIngestRefusal } from '../ingest-types.js';
/** Strict immutable condition capture only; no scope or authority is registered. */
export function captureCurrentDocCondition(raw: DocEventCondition): DocEventCondition {
  const value = captureCurrentDocConfiguration(raw);
  if (
    !/^[a-f0-9]{64}$/.test(value.expectedGeneration) ||
    Object.keys(value).some(
      (key) => key !== 'expectedGeneration' && key !== 'originalReceiptRetentionFloor'
    ) ||
    (value.originalReceiptRetentionFloor !== undefined &&
      (!Number.isSafeInteger(value.originalReceiptRetentionFloor) ||
        value.originalReceiptRetentionFloor < 0))
  )
    throw new DocIngestRefusal('INVALID_DOC_GENERATION_CONDITION', 400);
  return Object.freeze({
    expectedGeneration: value.expectedGeneration,
    ...(value.originalReceiptRetentionFloor !== undefined
      ? { originalReceiptRetentionFloor: value.originalReceiptRetentionFloor }
      : {}),
  });
}
/** Project current delivery DATA without exposing private authorization state. */
export function publicCurrentDelivery(row: import('../store.js').DocDeliveryRow) {
  return {
    eventId: row.eventId,
    routeId: row.routeId,
    batchId: row.batchId,
    status: row.status,
    turnId: row.turnId,
    reason: row.reason,
    updatedAt: row.updatedAt,
    ackOutcome: row.ackOutcome,
    acknowledgedAt: row.acknowledgedAt,
  };
}
/** Private operation data only; a caller cannot register a scope, choose access or obtain its connection. */

import { type DocBatchRow, type DocEventRow } from '../store.js';

/** Build the batch's bounded document-event context for its responder. */
export function buildBatchDocContext(
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

/** Complete literal before-effect row normalization; registration and sequence ownership remain in the store. */
export function buildCurrentAppendRow(
  input: import('../store.js').EventInput,
  sequence: number
): import('../store.js').DocEventRow {
  return copyCurrentDocData({
    ...input,
    docSeq: sequence,
    envelopeBytes: input.envelopeBytes ?? 0,
    payloadPrunedAt: input.payloadPrunedAt ?? null,
    coalesceKey: input.coalesceKey ?? null,
    clientTs: input.clientTs ?? null,
  });
}

/** Literal current request row data; no gate, append callback or registration is accepted. */
export function buildCurrentInputRow(
  input: ReturnType<typeof readCurrentDocIngressInput>,
  identity: { hash: string; bytes: number },
  now: string,
  provenance: import('../store.js').DocEventRow['provenance']
): import('../store.js').EventInput {
  return {
    documentId: input.documentId,
    eventId: input.event.id,
    direction: 'upstream',
    type: input.event.type,
    payload: input.event.payload,
    envelopeHash: identity.hash,
    envelopeBytes: identity.bytes,
    coalesceKey: input.event.coalesceKey ?? null,
    clientTs: input.event.ts ?? null,
    receivedAt: now,
    provenance,
  };
}

import { DocChannelCorruptionError, assertJson } from '../storage/store-json.js';
/** Literal persisted sequence/floor validation; allocation and private scope registration stay in the store. */
export function requireCurrentAppendBounds(
  channel: import('../store.js').DocChannelRow,
  documentId: string
): void {
  if (
    !Number.isSafeInteger(channel.nextDocSeq) ||
    channel.nextDocSeq < 1 ||
    channel.nextDocSeq >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(channel.receiptRetentionFloor) ||
    channel.receiptRetentionFloor < 1 ||
    channel.receiptRetentionFloor > channel.nextDocSeq
  )
    throw new DocChannelCorruptionError('canvas_doc_channels', documentId);
}

/** Literal insert data construction only; cannot allocate a sequence, mutate SQL or choose access. */
export function buildCurrentEventInsertValues(
  input: import('../store.js').EventInput,
  sequence: number
) {
  // Drizzle probes object prototypes before its JSON column encoder runs. Original
  // captured JSON deliberately has null prototypes; bind validated JSON text so
  // the query builder never treats that DATA as a possible SQL entity.
  assertJson(input.payload, CANVAS_CHANNEL_ENVELOPE_BYTES);
  assertJson(input.provenance, CANVAS_CHANNEL_ENVELOPE_BYTES);
  return {
    ...input,
    docSeq: sequence,
    payload: sql`${JSON.stringify(input.payload)}`,
    provenance: sql`${JSON.stringify(input.provenance)}`,
  };
}

/** Literal ordinary state/input validation; does not register a current operation or alter refusal order. */
export function requireCurrentStateInput(input: {
  documentId: string;
  expectedStateRev: number;
  state: import('../store.js').DocChannelRow['state'];
  event: import('../store.js').EventInput;
}): void {
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
}

import { DOC_EVENTS_PROMPT_BYTES } from '../prompt.js';
/** Literal finite selection bounds before any input lookup; no queue/permission capture. */
export function requireCurrentBatchSliceBounds(promptBytes: number, maxBatch: number): void {
  if (
    !Number.isSafeInteger(promptBytes) ||
    promptBytes < 1 ||
    promptBytes > DOC_EVENTS_PROMPT_BYTES
  )
    throw new RangeError('Invalid prompt byte maximum.');
  if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 100)
    throw new RangeError('Invalid batch maximum.');
}

/** Bounded stored JSON and batch metadata must remain immutable during admission. */
export function freezeAdmissionData(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeAdmissionData(child);
  Object.freeze(value);
}

/** Literal original admission row comparison; caller callback/write scope stays in the coalescer. */
export function requireCurrentAdmissionIdentity(
  accepted: import('../store.js').DocBatchRow,
  original: import('../store.js').DocBatchRow,
  selectedIds: string,
  selectedPayload: string
): void {
  if (
    accepted.generation !== original.generation ||
    accepted.documentId !== original.documentId ||
    accepted.routeId !== original.routeId ||
    accepted.grantId !== original.grantId ||
    accepted.grantRevision !== original.grantRevision ||
    accepted.dueAt !== original.dueAt ||
    JSON.stringify(accepted.inputEventIds) !== selectedIds ||
    JSON.stringify(accepted.effectivePayload) !== selectedPayload
  )
    throw new Error('Admission changed original input identity.');
}

/** Literal fixed mutation predicate data; cannot execute SQL, register a scope or replace the owner. */
export function buildCurrentSequencePredicate(documentId: string, nextDocSeq: number) {
  return and(
    eq(canvasDocChannels.documentId, documentId),
    eq(canvasDocChannels.nextDocSeq, nextDocSeq),
    isNull(canvasDocChannels.closedAt)
  );
}

/** Literal fixed mutation predicate data; cannot execute SQL, register a scope or replace the owner. */
export function buildCurrentBatchTransitionPredicate(
  input: Parameters<import('../store.js').DocChannelStore['transitionBatch']>[0]
) {
  return and(
    eq(canvasDocBatches.batchId, input.batchId),
    eq(canvasDocBatches.generation, input.generation),
    eq(canvasDocBatches.attempt, input.attempt),
    eq(canvasDocBatches.status, input.expectedStatus)
  );
}

/** Literal fixed mutation predicate data; cannot execute SQL, register a scope or replace the owner. */
export function buildCurrentStatePredicate(
  input: Parameters<import('../store.js').DocChannelStore['replaceState']>[0]
) {
  return and(
    eq(canvasDocChannels.documentId, input.documentId),
    eq(canvasDocChannels.stateRev, input.expectedStateRev),
    isNull(canvasDocChannels.closedAt)
  );
}

/** Literal fixed mutation predicate data; cannot execute SQL, register a scope or replace the owner. */
export function buildCurrentPendingBatchPredicate(
  input: Parameters<import('../store.js').DocChannelStore['updatePendingBatch']>[0]
) {
  return and(
    eq(canvasDocBatches.batchId, input.batchId),
    eq(canvasDocBatches.generation, input.generation),
    eq(canvasDocBatches.status, input.status)
  );
}

/** Literal fixed mutation predicate data; cannot execute SQL, register a scope or replace the owner. */
export function buildCurrentDeliveryTransitionPredicate(
  input: Parameters<import('../store.js').DocChannelStore['updateDelivery']>[0]
) {
  return and(
    eq(canvasDocDeliveries.documentId, input.documentId),
    eq(canvasDocDeliveries.eventId, input.eventId),
    eq(canvasDocDeliveries.routeId, input.routeId),
    eq(canvasDocDeliveries.status, input.expectedStatus)
  );
}

/** Immutable selected original data only; private constructor membership/currentness remains with grant revalidation. */
export function selectOriginalRoomGrantSource(
  original: {
    grants: import('../store.js').DocGrantRow[];
    approvals: (typeof import('@dorkos/db').approvals.$inferSelect)[];
    channel: import('../store.js').DocChannelRow;
  },
  input: ReturnType<typeof readCurrentDocIngressInput>,
  routeId: string
) {
  const decision = input.access?.routes.find((candidate) => candidate.route.id === routeId);
  const grant = original.grants.find((candidate) => candidate.grantId === decision?.grantId);
  const approval = original.approvals.find((candidate) => candidate.id === grant?.approvalId);
  if (
    !decision ||
    decision.reason ||
    decision.route.to !== 'room:self' ||
    !input.scope.startsWith('room:') ||
    !grant ||
    grant.documentId !== input.documentId ||
    grant.routeId !== routeId ||
    grant.revision !== decision.grantRevision ||
    grant.revokedAt !== null ||
    !grant.targetAgentId ||
    !grant.targetSessionId ||
    !grant.targetRuntime ||
    !approval ||
    approval.state !== 'granted' ||
    !approval.consumedAt
  )
    throw new Error('Original Room grant source is unavailable.');
  return copyCurrentDocData({ grant, approval, channel: original.channel });
}

/** Fresh original input/delivery data before any coalescing effect; never registers queue authority. */
export function captureCurrentBatchOriginalInputs(
  tx: DbTransaction,
  batch: DocBatchRow | undefined
) {
  return (batch?.inputEventIds ?? []).map((eventId) => {
    const original = readDocEventRow(tx, batch!.documentId, eventId);
    const delivery = tx
      .select()
      .from(canvasDocDeliveries)
      .where(
        and(
          eq(canvasDocDeliveries.documentId, batch!.documentId),
          eq(canvasDocDeliveries.eventId, eventId),
          eq(canvasDocDeliveries.routeId, batch!.routeId)
        )
      )
      .get();
    if (
      !original ||
      original.payloadPrunedAt !== null ||
      !delivery ||
      delivery.batchId !== batch!.batchId ||
      delivery.status !== batch!.status
    )
      throw new Error('Original pending input lacks its full correlated receipt.');
    return copyCurrentDocData({ original, delivery });
  });
}
/** Select only unchanged prior inputs plus the original newly planned input; no post-effect DTO reconstruction. */
export function buildCurrentRoomInputIntention(
  batch: DocBatchRow,
  prior: ReturnType<typeof captureCurrentBatchOriginalInputs>,
  event: DocEventRow,
  delivery: typeof canvasDocDeliveries.$inferSelect
) {
  const inputs = batch.inputEventIds.map((eventId) => {
    if (eventId === event.eventId) return copyCurrentDocData({ original: event, delivery });
    const retained = prior.find((input) => input.original.eventId === eventId);
    if (!retained) throw new Error('Original queued input was not captured before effects.');
    return retained;
  });
  if (
    new Set(inputs.map((input) => input.original.eventId)).size !== inputs.length ||
    inputs.some(
      (input, index) => index > 0 && input.original.docSeq <= inputs[index - 1].original.docSeq
    )
  )
    throw new Error('Original input order is not strict.');
  return copyCurrentDocData(inputs);
}

/** Literal pre-effect intended batch data; private queue membership and once capture stay coalescer-owned. */
export function buildCurrentQueueBatchIntention(
  batch: DocBatchRow | undefined,
  event: DocEventRow,
  access: import('../ingest-types.js').DocIngestAccess,
  decision: import('../ingest-types.js').DocRouteDecision,
  ids: string[],
  batchId: string,
  generation: string,
  now: string
): DocBatchRow {
  const { route, grantId, grantRevision } = decision;
  if (!grantId || !grantRevision) throw new Error('Queue requires verified turn authority.');
  return batch
    ? { ...batch, inputEventIds: ids, effectivePayload: { eventIds: ids }, updatedAt: now }
    : {
        batchId,
        documentId: event.documentId,
        scope: access.scope,
        routeId: route.id,
        grantId,
        grantRevision,
        generation,
        inputEventIds: ids,
        effectivePayload: { eventIds: ids },
        dueAt: new Date(
          Date.parse(now) + (route.turn.mode === 'coalesce' ? route.turn.windowMs : 0)
        ).toISOString(),
        status: 'pending',
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
        createdAt: now,
        updatedAt: now,
      };
}

import { readChecked } from '../storage/store-json.js';
import { docDocumentGeneration } from '../identity/incarnation.js';
/** Pure fixed SQL birth capture; engine alone validates access, condition and private scope. */
export function readCurrentDocBirthRows(tx: DbTransaction, documentId: string) {
  const physical = tx
    .select()
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, documentId))
    .get();
  const channel = readChecked('canvas_doc_channels', documentId, () =>
    tx.select().from(canvasDocChannels).where(eq(canvasDocChannels.documentId, documentId)).get()
  );
  if (!physical || !channel) return undefined;
  const birth = Object.freeze({
    physicalId: physical.id,
    openedAt: physical.openedAt,
    documentId: channel.documentId,
    createdAt: channel.createdAt,
  });
  const generation = docDocumentGeneration(physical, channel);
  return { physical, channel, birth, generation };
}

/** Full fixed batch receipt slice: missing, altered, foreign and extra correlated rows all refuse. */
export function requireCurrentQueueMembership(
  tx: DbTransaction,
  batchId: string,
  expected: readonly (typeof canvasDocDeliveries.$inferSelect)[]
): void {
  const actual = tx
    .select()
    .from(canvasDocDeliveries)
    .where(eq(canvasDocDeliveries.batchId, batchId))
    .all();
  if (
    actual.length !== expected.length ||
    new Set(expected.map((row) => `${row.documentId}:${row.eventId}:${row.routeId}`)).size !==
      expected.length ||
    actual.some((row) => !expected.some((intended) => sameCurrentDocData(intended, row)))
  )
    throw new Error('Full original batch receipt cardinality/content changed.');
}

/** Full fixed readonly original-row data capture. The helper alone owns genuine grant/scope and private issuance. */
export function readOriginalRoomRowIntention(
  tx: DbTransaction,
  documentId: string,
  grantId: string,
  approvalId: string
): Readonly<import('./current-operation-types.js').OriginalRoomPreEffectWitness> {
  const document = tx.get<Record<string, unknown>>(sql`
    SELECT * FROM canvas_documents WHERE id=${documentId}`);
  const channelBirth = tx.get<Record<string, unknown>>(sql`
    SELECT document_id,scope,created_at,declaration,declaration_hash,opener_agent_id,manifest_hash
    FROM canvas_doc_channels WHERE document_id=${documentId}`);
  const grant = tx.get<Record<string, unknown>>(sql`
    SELECT * FROM canvas_doc_grants WHERE grant_id=${grantId}`);
  const approval = tx.get<Record<string, unknown>>(sql`
    SELECT * FROM approvals WHERE id=${approvalId}`);
  const owner = tx.get<Record<string, unknown>>(sql`
    SELECT * FROM user ORDER BY created_at ASC LIMIT 1`);
  if (!document || !channelBirth || !grant || !approval || !owner)
    throw new Error(
      'Original Room acceptance lacks complete pre-effect physical/grant/approval/owner rows.'
    );
  return copyCurrentDocData({ document, channelBirth, grant, approval, owner });
}

import { requireCurrentQueueMembership } from './current-operation-intentions.js';
import {
  and,
  eq,
  sql,
  canvasDocDeliveries,
  type DbTransaction,
  agents,
  sessionMetadata,
  canvasDocuments,
  canvasDocChannels,
  canvasDocIdentityIntents,
  inArray,
  type Db,
  canvasDocBatches,
  canvasDocEvents,
  gte,
  asc,
  gt,
  lte,
  canvasDocGrants,
  approvals,
} from '@dorkos/db';
import { type DocChannelStore, auditCurrentDocAppendIntentions } from '../store.js';

import {
  type DocChannelAuthorization,
  type readCurrentDocIngressInput,
  DocChannelNotFoundError,
  readCurrentDocPendingRoomWriteCount,
} from '../authorization.js';
import { copyCurrentDocData, sameCurrentDocData } from './current-operation-data.js';
import {
  readDocEventRow,
  resolveCheckboxSqlScope,
} from '../writes/reservations/reservation-policy-census.js';
import { envelopeIdentity } from '../envelope.js';
import { readCheckboxOriginalIntent } from '../writes/reservations/reservation-audit.js';
import { validateCheckboxEvidence } from '../writes/checkbox-evidence.js';
import {
  readCurrentDocQueueAudit,
  readCurrentDocQueueDeliveries,
  readCurrentDocQueueWriteCount,
  type CurrentQueueIntent,
} from '../coalescer.js';
import { type captureCurrentIngestIntention } from './current-operation-intentions.js';
/** Fixed readonly full-row/status/outbox/native-count comparison; poisoning remains the ingestor's catch. */
export function auditCurrentIngestIntention(
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction,
  input: ReturnType<typeof readCurrentDocIngressInput>,
  own: ReturnType<typeof captureCurrentIngestIntention>
): void {
  const event = readDocEventRow(tx, own.documentId, own.eventId);
  const deliveries = tx
    .select()
    .from(canvasDocDeliveries)
    .where(
      and(
        eq(canvasDocDeliveries.documentId, own.documentId),
        eq(canvasDocDeliveries.eventId, own.eventId)
      )
    )
    .all()
    .sort((a, b) => (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0));
  if (own.duplicate) {
    if (
      !sameCurrentDocData(own.original, event) ||
      !sameCurrentDocData(
        [...own.deliveries].sort((a, b) =>
          a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0
        ),
        deliveries
      )
    )
      throw new Error('Retained original receipt changed during inspection.');
    return;
  }
  const intended = auditCurrentDocAppendIntentions(store, authorization, tx);
  const original = intended[0];
  if (
    !original ||
    original.eventId !== input.event.id ||
    original.documentId !== input.documentId ||
    original.direction !== 'upstream' ||
    original.type !== input.event.type ||
    original.envelopeHash !== envelopeIdentity(input.event).hash ||
    !sameCurrentDocData(original.payload, input.event.payload) ||
    original.receivedAt !== input.now ||
    !sameCurrentDocData(original.provenance, input.access?.provenance)
  )
    throw new Error('Current original input differs from its immutable request.');
  readCurrentDocQueueAudit(store, tx, original);
  const expected = [...own.deliveries, ...readCurrentDocQueueDeliveries(store, tx, original)].sort(
    (a, b) => (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0)
  );
  if (
    expected.length !== own.routes.length ||
    new Set(expected.map((row) => row.routeId)).size !== own.routes.length ||
    !sameCurrentDocData(expected.map((row) => row.routeId).sort(), [...own.routes].sort()) ||
    !sameCurrentDocData(expected, deliveries) ||
    intended.length !== expected.length + 1
  )
    throw new Error('Current route/outbox/status cardinality changed.');
  const expectedWrites =
    own.accountingWrites +
    readCurrentDocPendingRoomWriteCount(authorization, store, tx) +
    (own.checkbox?.completed ? 1 : 0) +
    intended.length * 2 +
    own.deliveries.length +
    readCurrentDocQueueWriteCount(store, tx, original);
  if (own.checkbox?.completed) {
    const originalIntent = own.checkbox.original;
    const receipt = own.checkbox.receipt;
    if (
      !receipt ||
      receipt.status !== 'recorded' ||
      receipt.id !== originalIntent.eventId ||
      receipt.docSeq !== original.docSeq
    )
      throw new Error('Original checkbox committed receipt changed.');
    const evidence = validateCheckboxEvidence(originalIntent);
    const expectedIntent = copyCurrentDocData({
      ...originalIntent,
      status: 'committed',
      updatedAt: original.receivedAt,
      errorCode: null,
      evidence: {
        ...evidence,
        receipt: { status: 'changed', receipt, fileVersion: originalIntent.afterHash },
      },
    });
    if (
      !sameCurrentDocData(expectedIntent, readCheckboxOriginalIntent(tx, originalIntent.intentId))
    )
      throw new Error('Original checkbox terminal row differs from its pre-effect intention.');
  }
  const finalChanges = tx.get<{ total: number }>(sql`SELECT total_changes() AS total`)!.total;
  if (
    !Number.isSafeInteger(expectedWrites) ||
    !Number.isSafeInteger(finalChanges) ||
    finalChanges - own.changesBefore !== expectedWrites
  )
    throw new Error('Current native writes differ from complete before-effect intentions.');
  for (let index = 0; index < expected.length; index++) {
    const delivery = expected[index];
    const status = intended[index + 1];
    const payload = {
      eventId: original.eventId,
      routeId: delivery.routeId,
      status: delivery.status,
      ...(delivery.batchId !== null ? { batchId: delivery.batchId } : {}),
      ...(delivery.reason !== null ? { reason: delivery.reason } : {}),
    };
    if (
      status.direction !== 'system' ||
      status.type !== 'event.status' ||
      status.documentId !== original.documentId ||
      status.receivedAt !== input.now ||
      !sameCurrentDocData(status.payload, payload) ||
      !sameCurrentDocData(status.provenance, { source: 'doc-channel-service' })
    )
      throw new Error('Current initial status differs from the pre-effect route intention.');
  }
}

import { type ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import { parseScope } from '../../scopes.js';

import { readChecked, DocChannelCorruptionError } from '../storage/store-json.js';

import { DocIngestRefusal } from '../ingest-types.js';
import { type CurrentOperationScope } from './current-operation-engine.js';
/** Fixed SQL policy data only; callbacks and genuine scope issuance remain owner-held. */
export function readCurrentDocAccessRows(
  executor: Db | DbTransaction,
  documentId: string,
  proof: ServerPrincipalProof,
  surface: 'http' | 'capability',
  ready: boolean
) {
  const claims = proof.claims;
  const identity = executor
    .select({ id: canvasDocuments.id, scope: canvasDocuments.scope })
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, documentId))
    .get();
  const channel = executor
    .select({ scope: canvasDocChannels.scope, closedAt: canvasDocChannels.closedAt })
    .from(canvasDocChannels)
    .where(eq(canvasDocChannels.documentId, documentId))
    .get();
  if (!identity || !channel || channel.closedAt !== null) throw new DocChannelNotFoundError();
  let scope: string;
  try {
    if (ready) requireCurrentDocReady(executor, documentId);
    scope = ready
      ? resolveCheckboxSqlScope(executor as DbTransaction, identity.scope)
      : identity.scope;
  } catch (cause) {
    // Preserve the original reduction-only cause privately: recovery/storage failure
    // must not become permanent authority loss if recovery completes before dispatch catches it.
    throw new DocChannelNotFoundError({ cause });
  }
  if (channel.scope !== scope) throw new DocChannelNotFoundError();
  const parsed = parseScope(scope);
  if (parsed.kind === 'unknown') throw new DocChannelNotFoundError();
  const runtimeScope =
    claims.kind === 'runtime' ? readCurrentRuntimeScope(executor, proof) : undefined;
  if (claims.kind === 'runtime' && !runtimeScope) throw new DocChannelNotFoundError();
  if (claims.kind === 'agent') {
    const agent = executor.select().from(agents).where(eq(agents.id, claims.agentId)).get();
    if (!agent || agent.status !== 'active' || agent.projectPath !== claims.agentPath)
      throw new DocChannelNotFoundError();
  }
  if (parsed.kind === 'session') {
    if (claims.kind !== 'operator' && (surface !== 'capability' || runtimeScope !== scope))
      throw new DocChannelNotFoundError();
  }
  return { id: identity.id, scope, roomId: parsed.kind !== 'session' ? parsed.id : undefined };
}
function readCurrentRuntimeScope(
  executor: Db | DbTransaction,
  proof: ServerPrincipalProof
): string | undefined {
  const claims = proof.claims;
  if (claims.kind !== 'runtime') return undefined;
  let canonical: string;
  try {
    canonical = resolveCheckboxSqlScope(
      executor as DbTransaction,
      `session:${claims.canonicalSessionId}`
    );
  } catch {
    return undefined;
  }
  const session = executor
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, canonical.slice(8)))
    .get();
  const agent = executor.select().from(agents).where(eq(agents.id, claims.agentId)).get();
  if (
    session?.runtime !== claims.runtime ||
    session.agentPath !== claims.agentPath ||
    agent?.projectPath !== claims.agentPath ||
    agent.runtime !== claims.runtime ||
    agent.status !== 'active'
  )
    return undefined;
  return canonical;
}

function requireCurrentDocReady(executor: Db | DbTransaction, documentId: string): void {
  const blocked = executor
    .select({ id: canvasDocIdentityIntents.intentId })
    .from(canvasDocIdentityIntents)
    .where(
      and(
        eq(canvasDocIdentityIntents.documentId, documentId),
        inArray(canvasDocIdentityIntents.status, ['pending', 'in_doubt', 'failed'])
      )
    )
    .get();
  if (blocked) throw new Error('Document identity recovery remains unresolved.');
}
/** Fresh final rows/birth/floor bounds after the owner has completed its final configured callback phase. */
export function auditCurrentDocFinalRows(
  tx: DbTransaction,
  own: Pick<
    CurrentOperationScope,
    | 'documentId'
    | 'scope'
    | 'birth'
    | 'physicalRow'
    | 'channelRow'
    | 'absentAdmission'
    | 'condition'
    | 'acceptedDocSeq'
    | 'capturedFloor'
  >,
  checked: { id: string; scope: string }
): void {
  const physical = tx
    .select()
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, own.documentId))
    .get();
  const channel = readChecked('canvas_doc_channels', own.documentId, () =>
    tx
      .select()
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, own.documentId))
      .get()
  );
  if (
    !physical ||
    !channel ||
    channel.closedAt !== null ||
    checked.id !== own.documentId ||
    checked.scope !== own.scope ||
    physical.scope !== own.scope ||
    channel.scope !== own.scope ||
    physical.id !== own.birth.physicalId ||
    physical.openedAt !== own.birth.openedAt ||
    channel.documentId !== own.birth.documentId ||
    channel.createdAt !== own.birth.createdAt
  )
    throw new DocChannelNotFoundError();
  if (
    !sameCurrentDocData(physical, own.physicalRow) ||
    !sameCurrentDocData(channel, {
      ...own.channelRow,
      nextDocSeq: channel.nextDocSeq,
      updatedAt: channel.updatedAt,
    })
  )
    throw new DocChannelNotFoundError();
  if (
    !Number.isSafeInteger(channel.nextDocSeq) ||
    channel.nextDocSeq < 1 ||
    channel.nextDocSeq >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(channel.receiptRetentionFloor) ||
    channel.receiptRetentionFloor < 1 ||
    channel.receiptRetentionFloor > channel.nextDocSeq
  )
    throw new DocChannelCorruptionError('canvas_doc_channels', own.documentId);
  if (
    own.absentAdmission &&
    own.condition.originalReceiptRetentionFloor !== undefined &&
    channel.receiptRetentionFloor !== own.condition.originalReceiptRetentionFloor
  )
    throw new DocIngestRefusal('DOC_RECEIPT_RETENTION_CHANGED', 409);
  if (
    own.acceptedDocSeq !== undefined &&
    (own.acceptedDocSeq < Math.max(own.capturedFloor, channel.receiptRetentionFloor) ||
      own.acceptedDocSeq >= channel.nextDocSeq)
  )
    throw new DocChannelCorruptionError('canvas_doc_channels', own.documentId);
}

/** Readonly exact queue/superseded comparison; no registry, identity capture or poison mutation. */
export function auditCurrentQueueRows(
  tx: DbTransaction,
  event: import('../store.js').DocEventRow,
  own: Pick<CurrentQueueIntent, 'routes' | 'superseded'>
): void {
  for (const [routeId, expected] of own.routes) {
    const batch = expected.batch
      ? tx
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.batchId, expected.batch.batchId))
          .get()
      : undefined;
    const delivery = tx
      .select()
      .from(canvasDocDeliveries)
      .where(
        and(
          eq(canvasDocDeliveries.documentId, event.documentId),
          eq(canvasDocDeliveries.eventId, event.eventId),
          eq(canvasDocDeliveries.routeId, routeId)
        )
      )
      .get();
    if (
      (expected.batch && !sameCurrentDocData(expected.batch, batch)) ||
      !sameCurrentDocData(expected.delivery, delivery)
    )
      throw new Error('Current original queue identity/projection changed.');
    if (expected.batch && expected.inputs)
      requireCurrentQueueMembership(tx, expected.batch.batchId, [
        ...expected.inputs.map((input) => input.delivery),
        ...own.superseded
          .filter((input) => input.delivery.batchId === expected.batch!.batchId)
          .map((input) => input.delivery),
      ]);
    for (const input of expected.inputs ?? []) {
      const original = readDocEventRow(tx, event.documentId, input.original.eventId);
      const receipt = tx
        .select()
        .from(canvasDocDeliveries)
        .where(
          and(
            eq(canvasDocDeliveries.documentId, event.documentId),
            eq(canvasDocDeliveries.eventId, input.original.eventId),
            eq(canvasDocDeliveries.routeId, routeId)
          )
        )
        .get();
      if (
        !sameCurrentDocData(input.original, original) ||
        !sameCurrentDocData(input.delivery, receipt)
      )
        throw new Error('Full original batch input or receipt changed.');
    }
  }
  for (const expected of own.superseded) {
    const original = tx
      .select()
      .from(canvasDocEvents)
      .where(
        and(
          eq(canvasDocEvents.documentId, event.documentId),
          eq(canvasDocEvents.eventId, expected.original.eventId)
        )
      )
      .get();
    const delivery = tx
      .select()
      .from(canvasDocDeliveries)
      .where(
        and(
          eq(canvasDocDeliveries.documentId, event.documentId),
          eq(canvasDocDeliveries.eventId, expected.original.eventId),
          eq(canvasDocDeliveries.routeId, expected.delivery.routeId)
        )
      )
      .get();
    if (
      !sameCurrentDocData(expected.original, original) ||
      !sameCurrentDocData(expected.delivery, delivery)
    )
      throw new Error('Superseded original input or receipt changed.');
  }
}

/** Fixed fresh full slice comparison; caller cannot register or replace the owner's captured rows. */
export function auditCurrentAppendSlice(
  tx: DbTransaction,
  own: { documentId: string; firstSeq: number; rows: readonly import('../store.js').DocEventRow[] }
): readonly import('../store.js').DocEventRow[] {
  const channel = readChecked('canvas_doc_channels', own.documentId, () =>
    tx
      .select()
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, own.documentId))
      .get()
  );
  const rows = tx
    .select()
    .from(canvasDocEvents)
    .where(
      and(eq(canvasDocEvents.documentId, own.documentId), gte(canvasDocEvents.docSeq, own.firstSeq))
    )
    .orderBy(canvasDocEvents.docSeq)
    .all();
  if (
    !channel ||
    channel.nextDocSeq !== own.firstSeq + own.rows.length ||
    !sameCurrentDocData(rows, own.rows)
  )
    throw new Error('Current event slice/cardinality differs from its pre-effect intentions.');
  return own.rows;
}

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

import { DocRouteGrantError } from '../grant-policy.js';
/** Original full grant/approval/channel SQL evidence, never copied fallback approval. */
export function readCurrentGrantSourceRows(documentId: string, tx: DbTransaction) {
  const grants = readChecked('canvas_doc_grants', documentId, () =>
    tx.select().from(canvasDocGrants).where(eq(canvasDocGrants.documentId, documentId)).all()
  );
  const originalApprovals = grants
    .filter((grant) => grant.approvalId !== null)
    .map((grant) => tx.select().from(approvals).where(eq(approvals.id, grant.approvalId!)).get());
  if (originalApprovals.some((row) => !row))
    throw new DocRouteGrantError('GRANT_EVIDENCE_MISMATCH');
  const channel = readChecked('canvas_doc_channels', documentId, () =>
    tx.select().from(canvasDocChannels).where(eq(canvasDocChannels.documentId, documentId)).get()
  );
  if (!channel) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
  return copyCurrentDocData({
    grants,
    approvals: originalApprovals as (typeof approvals.$inferSelect)[],
    channel,
  });
}

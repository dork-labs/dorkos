import type { DocBatchRow } from '../store.js';
import type { DocChannelActor } from '../authorization.js';
import { and, eq, canvasDocDeliveries, type DbTransaction } from '@dorkos/db';
import {
  CanvasChannelSendRequestSchema,
  CanvasChannelAppAckSchema,
  type CanvasChannelSendRequest,
  type IngestReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import type { OriginalRoomEmissionStage } from '../current/current-operation-types.js';
import {
  readOriginalRoomEmissionPrincipal,
  readOriginalRoomEmissionSource,
  refreshOriginalRoomEmissionStage,
  executeOriginalRoomResponderEmission,
  requireOriginalRoomEmissionTransaction,
} from '../operations/room-responder-operation.js';
import type { OriginalDownstreamRoomEmitter } from './native-room-emitter.js';
import {
  DocDownstreamError,
  readOriginalDownstreamOperationView,
  type DocDownstreamAccess,
} from './service.js';
/** Continue the complete original private sendOriginalNativeRoom body only for its genuine constructor key. */
export async function sendOriginalNativeRoom(
  owner: object,
  emitter: OriginalDownstreamRoomEmitter,
  stage: OriginalRoomEmissionStage,
  raw: unknown
): Promise<{ receipt: IngestReceipt }> {
  const facet = readOriginalDownstreamOperationView(owner);
  const own = facet.emitter(emitter)!;
  const request = CanvasChannelSendRequestSchema.parse(raw);
  const ack =
    request.type === 'app.ack' ? CanvasChannelAppAckSchema.parse(request.payload) : undefined;
  const principal = readOriginalRoomEmissionPrincipal(stage, own.db);
  const source = readOriginalRoomEmissionSource(stage, own.db);
  facet.actor({ surface: 'capability', principal });
  if (
    request.documentId !== source.documentId ||
    request.roomId !== source.roomId ||
    source.scope !== `room:${source.roomId}`
  )
    throw new DocDownstreamError('INVALID_NATIVE_ROOM_CORRELATION', 409);
  const ids = source.inputs.map((input) => input.eventId);
  if (ack) {
    if (
      ack.batchId !== source.batchId ||
      ack.routeId !== source.routeId ||
      ack.eventIds.some((id) => !ids.includes(id))
    )
      throw new DocDownstreamError('INVALID_APP_ACK_CORRELATION', 409);
  } else {
    const reply = request.payload as { inReplyTo?: unknown };
    if (
      !reply ||
      typeof reply !== 'object' ||
      !Array.isArray(reply.inReplyTo) ||
      !reply.inReplyTo.length ||
      new Set(reply.inReplyTo).size !== reply.inReplyTo.length ||
      reply.inReplyTo.some((id) => typeof id !== 'string' || !ids.includes(id))
    )
      throw new DocDownstreamError('INVALID_NATIVE_ROOM_REPLY_CORRELATION', 409);
  }
  // All original awaited preflight happened in prepare. Capture configured clock before final native refresh.
  const now = facet.clock().toISOString();
  refreshOriginalRoomEmissionStage(stage, own.db);
  if (own.retired) throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_EMITTER_RETIRED', 409);
  if (own.prepared.has(stage))
    throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_STAGE_REENTRY', 409);
  own.prepared.set(stage, { request, ack, principal, source, now });
  try {
    return executeOriginalRoomResponderEmission(stage, emitter, request);
  } finally {
    own.prepared.delete(stage);
  }
}
/** Continue the complete original private sendOriginalNativeRoomInsideFrame body only for its genuine constructor key. */
export function sendOriginalNativeRoomInsideFrame(
  owner: object,
  emitter: OriginalDownstreamRoomEmitter,
  stage: OriginalRoomEmissionStage,
  tx: DbTransaction,
  request: CanvasChannelSendRequest
): { receipt: IngestReceipt } {
  const facet = readOriginalDownstreamOperationView(owner);
  const own = facet.emitter(emitter)!;
  const prepared = own.prepared.get(stage);
  if (!prepared || prepared.request !== request)
    throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_STAGE_REQUIRED', 409);
  const { ack, principal, source, now } = prepared;
  return facet.atomic(() => {
    if (own.active) throw new DocDownstreamError('ORIGINAL_DOWNSTREAM_TRANSACTION_REENTRY', 409);
    own.active = { stage, tx, principal };
    try {
      requireOriginalRoomEmissionTransaction(stage, own.db, tx, principal, emitter);
      const batch = own.source.getBatch(source.batchId, tx);
      const channel = own.source.getChannel(source.documentId, tx);
      if (
        !batch ||
        batch.generation !== source.generation ||
        batch.documentId !== source.documentId ||
        batch.routeId !== source.routeId ||
        batch.grantId !== source.grantId ||
        batch.grantRevision !== source.grantRevision ||
        !channel ||
        channel.closedAt ||
        channel.scope !== source.scope
      )
        throw new DocDownstreamError('INVALID_NATIVE_ROOM_CORRELATION', 409);
      const claims = principal.claims;
      if (claims.kind !== 'runtime') throw new DocDownstreamError('CANVAS_DOCUMENT_NOT_FOUND', 404);
      const access: DocDownstreamAccess = {
        id: source.documentId,
        scope: source.scope,
        senderKey: `runtime:${claims.runtime}:${claims.agentId}`,
        evidence: {
          agentId: claims.agentId,
          runtime: claims.runtime,
          sessionId: claims.canonicalSessionId,
          agentPath: claims.agentPath,
          bindingId: claims.bindingId,
          grantId: source.grantId,
          grantRevision: source.grantRevision,
          batchId: source.batchId,
          generation: source.generation,
          admissionId: source.admissionId,
          originalSourceHash: source.originalSourceHash,
        },
      };
      const hash = hashApprovalInput(request);
      const existing = own.source.getEvent(source.documentId, request.eventId, tx);
      if (existing) {
        if (existing.envelopeHash !== hash || existing.direction !== 'downstream')
          throw new DocDownstreamError('DOC_EVENT_ID_CONFLICT', 409);
        requireOriginalRoomEmissionTransaction(stage, own.db, tx, principal, emitter);
        return { receipt: facet.receipt(existing, true) };
      }
      facet.rate(access, now, tx);
      const deliveries = ack
        ? ack.eventIds.map((id) =>
            own.source
              .listDeliveries(source.documentId, id, tx)
              .find((row) => row.routeId === source.routeId && row.batchId === source.batchId)
          )
        : [];
      if (deliveries.some((row) => !row || (row.ackOutcome && row.ackOutcome !== ack!.outcome)))
        throw new DocDownstreamError('INVALID_APP_ACK_CORRELATION', 409);
      // Fixed last native/current source/FIRST gate; no awaited/configured callback follows before mutations.
      requireOriginalRoomEmissionTransaction(stage, own.db, tx, principal, emitter);
      for (const row of deliveries) {
        if (row!.ackOutcome) continue;
        tx.update(canvasDocDeliveries)
          .set({
            ackOutcome: ack!.outcome,
            acknowledgedAt: now,
            acknowledgedBy: access.senderKey,
            ackEvidence: {
              ...access.evidence,
              downstreamEventId: request.eventId,
              routeId: source.routeId,
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(canvasDocDeliveries.documentId, source.documentId),
              eq(canvasDocDeliveries.eventId, row!.eventId),
              eq(canvasDocDeliveries.routeId, source.routeId)
            )
          )
          .run();
      }
      const event = own.source.appendEvent(
        facet.event(
          source.documentId,
          request.eventId,
          request.type,
          request.payload,
          hash,
          request,
          access,
          now
        ),
        tx
      );
      requireOriginalRoomEmissionTransaction(stage, own.db, tx, principal, emitter);
      return { receipt: facet.receipt(event, false) };
    } finally {
      own.active = undefined;
    }
  });
}

/** Continue the complete original private readOriginalReplyBatch body only for its genuine constructor key. */
export function readOriginalReplyBatch(
  owner: object,
  request: CanvasChannelSendRequest,
  actor: DocChannelActor,
  tx?: DbTransaction
): DocBatchRow | undefined {
  const facet = readOriginalDownstreamOperationView(owner);
  const claims = actor.principal.claims;
  if (claims.kind !== 'runtime') return undefined;
  const payload = request.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const ids = (payload as { inReplyTo?: unknown }).inReplyTo;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== 'string') ||
    new Set(ids).size !== ids.length
  )
    return undefined;
  const candidates = new Map<string, DocBatchRow>();
  for (const delivery of facet.store.listDeliveries(request.documentId, ids[0]!, tx)) {
    if (!delivery.batchId) continue;
    const batch = facet.store.getBatch(delivery.batchId, tx);
    if (
      !batch ||
      batch.documentId !== request.documentId ||
      !batch.scope.startsWith('session:') ||
      !ids.every((id) => batch.inputEventIds.includes(id))
    )
      continue;
    const grant = facet.store.getGrant(batch.grantId, tx);
    if (!grant || grant.targetAgentId !== claims.agentId || grant.targetRuntime !== claims.runtime)
      continue;
    if (
      !ids.every((id) =>
        facet.store
          .listDeliveries(request.documentId, id, tx)
          .some((row) => row.batchId === batch.batchId && row.routeId === batch.routeId)
      )
    )
      continue;
    candidates.set(batch.batchId, batch);
  }
  // Before preflight, select only an identifier; disclose ambiguity after current responder authorization.
  if (tx && candidates.size > 1)
    throw new DocDownstreamError('INVALID_AGENT_REPLY_CORRELATION', 409);
  return candidates.values().next().value;
}

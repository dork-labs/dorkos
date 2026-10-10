/** Exact source authority and immutable input reconstruction for private document admission. */
import { createHash } from 'node:crypto';
import {
  canvasDocuments,
  eq,
  type DbTransaction,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';
import {
  CanvasChannelDocEventsContextSchema,
  matchesCanvasChannelEvent,
  type CanvasChannelDocEventsContext,
} from '@dorkos/shared/canvas-channel-schemas';
import { canonicalCanvasAppJson } from '@dorkos/shared/canvas-app-manifest';
import { PrivateSessionMessageRefusalError } from '../../../session/private-messages/acceptance.js';
import { DocChannelStore, type DocBatchRow, type DocGrantRow } from '../store.js';
import type { DocChannelGrants } from '../grants.js';
import type { DocGrantTarget } from '../grant-policy.js';
import { batchContext } from '../coalescer.js';
import { envelopeIdentity } from '../envelope.js';
import { docEventsPromptBytes, DOC_EVENTS_PROMPT_BYTES } from '../prompt.js';

/** Stored batch, exact grant and current canonical destination proven together. */
export interface DocBatchAuthority {
  batch: DocBatchRow;
  grant: DocGrantRow;
  target: DocGrantTarget;
  context: CanvasChannelDocEventsContext;
  inputFingerprint: { id: string; docSeq: number; envelopeHash: string }[];
}
/** Refuse without disclosing private source content. */
export function refuseDocBatch(code = 'document_authority_changed'): never {
  throw new PrivateSessionMessageRefusalError(code, 'This document update is no longer available.');
}
/** Read the bounded live label only after grant authority has authorized the private document. */
export function docBatchLabel(tx: DbTransaction, batch: DocBatchRow): string {
  const frozen = (batch.effectivePayload as { documentLabel?: unknown }).documentLabel;
  if (typeof frozen === 'string') return frozen;
  const document = tx
    .select({ title: canvasDocuments.title })
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, batch.documentId))
    .get();
  if (!document) refuseDocBatch('document_closed');
  return document.title.slice(0, 500);
}
/** Reconstruct every immutable selected input; absence, alteration or pruning refuses the whole batch. */
export function readDocBatchAuthority(
  store: Pick<DocChannelStore, 'getEvent'>,
  grants: Pick<DocChannelGrants, 'revalidateBatchGrant'>,
  tx: DbTransaction,
  batch: DocBatchRow
): DocBatchAuthority {
  const { grant, target } = grants.revalidateBatchGrant(batch, tx);
  if (!batch.scope.startsWith('session:')) refuseDocBatch('document_session_target_required');
  if (
    !target.agentId ||
    !target.sessionId ||
    !target.runtime ||
    !target.agentPath ||
    (grant.normalizedRoute && (grant.normalizedRoute as { to?: string }).to === 'room:self')
  )
    refuseDocBatch('document_session_target_required');
  if (target.scope !== batch.scope) refuseDocBatch('document_session_target_required');
  if (
    !batch.inputEventIds.length ||
    batch.inputEventIds.length > 100 ||
    new Set(batch.inputEventIds).size !== batch.inputEventIds.length
  )
    refuseDocBatch('document_input_changed');
  const events = batch.inputEventIds.map((id) => {
    const event = store.getEvent(batch.documentId, id, tx);
    if (!event || event.payloadPrunedAt !== null || event.direction !== 'upstream')
      refuseDocBatch('document_input_missing');
    const hash = envelopeIdentity({
      v: 1,
      id: event.eventId,
      type: event.type,
      payload: event.payload as CanvasChannelDocEventsContext['events'][number]['payload'],
      ...(event.coalesceKey === null ? {} : { coalesceKey: event.coalesceKey }),
      ...(event.clientTs === null ? {} : { ts: event.clientTs }),
    }).hash;
    if (
      hash !== event.envelopeHash ||
      !(grant.allowedTypes as string[]).some((pattern) =>
        matchesCanvasChannelEvent(pattern, event.type)
      )
    )
      refuseDocBatch('document_input_changed');
    return event;
  });
  if (events.some((event, index) => index > 0 && event.docSeq <= events[index - 1]!.docSeq))
    refuseDocBatch('document_input_changed');
  const context = CanvasChannelDocEventsContextSchema.parse(
    batchContext(batch, events, docBatchLabel(tx, batch))
  );
  if (docEventsPromptBytes(context) > DOC_EVENTS_PROMPT_BYTES)
    refuseDocBatch('document_context_too_large');
  return {
    batch,
    grant,
    target,
    context,
    inputFingerprint: events.map((event) => ({
      id: event.eventId,
      docSeq: event.docSeq,
      envelopeHash: event.envelopeHash,
    })),
  };
}
/** Source-owned digest includes exact approved identity, immutable inputs and current canonical ownership. */
export function docBatchDigest(
  authority: DocBatchAuthority,
  previousSessionId?: string,
  previousSourceScope?: string
): string {
  const { batch, grant, target } = authority;
  const binding = (grant.approvalEvidence as { binding?: { origin?: unknown } }).binding;
  return createHash('sha256')
    .update(
      canonicalCanvasAppJson({
        documentId: batch.documentId,
        batchId: batch.batchId,
        generation: batch.generation,
        inputs: authority.inputFingerprint,
        documentLabel: authority.context.documentLabel,
        scope: previousSourceScope ?? batch.scope,
        grantId: grant.grantId,
        grantRevision: grant.revision,
        routeId: batch.routeId,
        routeHash: grant.routeHash,
        declarationHash: grant.declarationHash,
        manifestHash: grant.manifestHash,
        origin: binding?.origin ?? null,
        openerAgentId: grant.openerAgentId,
        target: {
          agentId: target.agentId,
          sessionId: previousSessionId ?? target.sessionId,
          runtime: target.runtime,
          agentPath: target.agentPath,
        },
      })
    )
    .digest('hex');
}
/** Verify the exact receipt/source link and unchanged authority before claim or canonical rebind. */
export function verifyDocReceipt(
  authority: DocBatchAuthority,
  receipt: SessionMessageAcceptanceReceipt,
  previousSessionId?: string,
  previousSourceScope?: string
): void {
  if (
    receipt.sourceKind !== 'document_event_batch' ||
    receipt.sourceId !== authority.batch.batchId ||
    receipt.sourceGeneration !== authority.batch.generation ||
    authority.batch.admissionReceiptId !== receipt.id ||
    receipt.agentId !== authority.target.agentId ||
    receipt.originRuntime !== authority.target.runtime ||
    receipt.originAgentPath !== authority.target.agentPath ||
    receipt.sessionId !== (previousSessionId ?? authority.target.sessionId) ||
    receipt.originAuthorityDigest !==
      docBatchDigest(authority, previousSessionId, previousSourceScope)
  )
    refuseDocBatch();
}

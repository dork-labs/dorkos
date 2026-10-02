/** Fixed document source for the existing protected session-message coordinator. */
import {
  and,
  eq,
  inArray,
  isNull,
  canvasDocBatches,
  canvasDocDeliveries,
  canvasDocGrants,
  type DbTransaction,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';
import type {
  PrivateSessionMessageSourceAdapter,
  PrivateSessionMessageSourceRef,
  PrivateSessionMessageDraft,
  PreparedPrivateSessionMessage,
  PrivateSessionMessageTurnInput,
} from '../../../session/private-messages/acceptance.js';
import { DocChannelStore, type DocBatchRow } from '../store.js';
import type { DocChannelGrants } from '../grants.js';
import {
  readDocBatchAuthority,
  docBatchDigest,
  verifyDocReceipt,
  refuseDocBatch,
} from './batch-authority.js';
import { DocRouteGrantError } from '../grant-policy.js';
import { DocChannelNotFoundError, DocChannelArchivedError } from '../authorization.js';
import { PrivateSessionMessageRefusalError } from '../../../session/private-messages/refusal.js';
import { CanvasAppManifestError } from '@dorkos/shared/canvas-app-manifest';
import { sessionMessageAcceptanceReceipts } from '@dorkos/db';
import { appendDocStatus } from '../status.js';

/** Only immutable document batch identity enters the protected source boundary. */
export type DocBatchSourceRef = Extract<
  PrivateSessionMessageSourceRef,
  { kind: 'document_event_batch' }
>;
/** Safe queue/runtime sentence; all page data travels only through structured fenced context. */
export function docBatchPlaceholder(batch: DocBatchRow): string {
  const count = batch.inputEventIds.length;
  return `[Document update: ${count} ${count === 1 ? 'action' : 'actions'}]`;
}
/** Fixed source with no public Relay publication or alternate delivery ledger. */
export class DocumentEventBatchSource implements PrivateSessionMessageSourceAdapter<DocBatchSourceRef> {
  readonly kind = 'document_event_batch' as const;
  /** Only source-owned permanent refusals can retire unclaimed accepted work. */
  isPreclaimRefusal(error: unknown): boolean {
    // The original hidden cause survives recovery finishing before classification.
    // A fresh intent census cannot explain why an earlier not-found response occurred.
    if (error instanceof DocChannelNotFoundError && Object.hasOwn(error, 'cause')) return false;
    return (
      (error instanceof DocRouteGrantError &&
        error.status < 500 &&
        error.code !== 'AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY') ||
      (error instanceof PrivateSessionMessageRefusalError &&
        [
          'document_authority_changed',
          'document_closed',
          'document_session_target_required',
          'document_input_changed',
          'document_input_missing',
          'document_context_too_large',
          'document_batch_changed',
          'document_turn_correlation_changed',
        ].includes(error.code)) ||
      error instanceof CanvasAppManifestError ||
      error instanceof DocChannelNotFoundError ||
      error instanceof DocChannelArchivedError
    );
  }
  private readonly rebindFailures = new WeakMap<
    object,
    { receipt: SessionMessageAcceptanceReceipt; grantId: string; documentId: string; scope: string }
  >();
  /** Compose exact grant authority on the same channel transaction connection. */
  constructor(
    private readonly store: DocChannelStore,
    private readonly grants: DocChannelGrants,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Commit any observed manifest suspension before admission/prepare starts its transaction. */
  refresh(ref: DocBatchSourceRef): void {
    const batch = this.store.getBatch(ref.batchId);
    if (!batch || batch.generation !== ref.sourceGeneration)
      refuseDocBatch('document_batch_changed');
    this.grants.refreshGrantedAuthority(batch.grantId);
  }
  /** Consume only selected pending originals under current exact authority. */
  consume(tx: DbTransaction, ref: DocBatchSourceRef): PrivateSessionMessageDraft {
    const batch = this.requireBatch(tx, ref, ['pending', 'waiting']);
    if (batch.admissionReceiptId) refuseDocBatch('document_batch_already_accepted');
    const authority = readDocBatchAuthority(this.store, this.grants, tx, batch);
    return {
      sourceKind: this.kind,
      sourceId: batch.batchId,
      sourceGeneration: batch.generation,
      sessionId: authority.target.sessionId!,
      agentId: authority.target.agentId!,
      originRuntime: authority.target.runtime!,
      originAgentPath: authority.target.agentPath!,
      originAuthorityDigest: docBatchDigest(authority),
      queuePlaceholder: docBatchPlaceholder(batch),
    };
  }
  /** Link actual shared receipt identity while the source/queue/receipt transaction remains open. */
  onAccepted(tx: DbTransaction, receipt: SessionMessageAcceptanceReceipt, now: string): undefined {
    const batch = this.requireBatch(tx, receiptRef(receipt), ['pending', 'waiting']);
    const authority = readDocBatchAuthority(this.store, this.grants, tx, batch);
    if (docBatchDigest(authority) !== receipt.originAuthorityDigest) refuseDocBatch();
    const changed = tx
      .update(canvasDocBatches)
      .set({ status: 'accepted', admissionReceiptId: receipt.id, updatedAt: now })
      .where(
        and(
          eq(canvasDocBatches.batchId, batch.batchId),
          eq(canvasDocBatches.generation, batch.generation),
          inArray(canvasDocBatches.status, ['pending', 'waiting']),
          isNull(canvasDocBatches.admissionReceiptId)
        )
      )
      .run().changes;
    if (changed !== 1) refuseDocBatch('document_batch_already_accepted');
    tx.update(canvasDocDeliveries)
      .set({ status: 'routed', updatedAt: now })
      .where(
        and(
          eq(canvasDocDeliveries.batchId, batch.batchId),
          inArray(canvasDocDeliveries.eventId, batch.inputEventIds)
        )
      )
      .run();
  }
  /** Prepare structured records in memory after committed manifest refresh. */
  async prepare(receipt: SessionMessageAcceptanceReceipt): Promise<PreparedPrivateSessionMessage> {
    this.refresh(receiptRef(receipt));
    return this.store.transaction((tx) => {
      const batch = this.requireBatch(tx, receiptRef(receipt), ['accepted']);
      const authority = this.readReceiptAuthority(tx, batch, receipt);
      verifyDocReceipt(authority, receipt);
      return {
        sourceKind: this.kind,
        sourceId: receipt.sourceId,
        sourceGeneration: receipt.sourceGeneration,
        content: docBatchPlaceholder(batch),
        docEvents: authority.context,
      };
    });
  }
  /** Rebuild canonical context and exclusively advance the source at the final synchronous claim. */
  revalidate(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    _prepared: PreparedPrivateSessionMessage,
    now: string
  ): PrivateSessionMessageTurnInput {
    const batch = this.requireBatch(tx, receiptRef(receipt), ['accepted']);
    const authority = this.readReceiptAuthority(tx, batch, receipt);
    verifyDocReceipt(authority, receipt);
    const changed = tx
      .update(canvasDocBatches)
      .set({ status: 'dispatching', updatedAt: now })
      .where(
        and(
          eq(canvasDocBatches.batchId, batch.batchId),
          eq(canvasDocBatches.generation, batch.generation),
          eq(canvasDocBatches.admissionReceiptId, receipt.id),
          eq(canvasDocBatches.status, 'accepted')
        )
      )
      .run().changes;
    if (changed !== 1) refuseDocBatch();
    return { content: docBatchPlaceholder(batch), docEvents: authority.context };
  }
  /** Revalidate canonical grant authority against the old exact digest inside the ownership move. */
  rebindAccepted(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    toSessionId: string,
    _now: string
  ): string | undefined {
    const batch = this.requireBatch(tx, receiptRef(receipt), ['accepted']);
    const authority = this.readReceiptAuthority(tx, batch, receipt);

    if (authority.target.sessionId !== toSessionId) refuseDocBatch();
    verifyDocReceipt(authority, receipt, receipt.sessionId);
    return docBatchDigest(authority);
  }
  /** Reduce only the exact observed grant after a rolled-back ownership move. */
  onRebindFailed(error: unknown): undefined {
    if (!error || typeof error !== 'object') return;
    const evidence = this.rebindFailures.get(error);
    if (!evidence) return;
    this.rebindFailures.delete(error);
    this.store.transaction((tx) => {
      const batch = this.store.getBatch(evidence.receipt.sourceId, tx);
      const receipt = tx
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, evidence.receipt.id))
        .get();
      if (
        !batch ||
        batch.scope !== evidence.scope ||
        batch.generation !== evidence.receipt.sourceGeneration ||
        batch.grantId !== evidence.grantId ||
        batch.documentId !== evidence.documentId ||
        batch.admissionReceiptId !== evidence.receipt.id ||
        receipt?.state !== 'accepted' ||
        receipt.originAuthorityDigest !== evidence.receipt.originAuthorityDigest
      )
        refuseDocBatch();
      tx.update(canvasDocGrants)
        .set({ revokedAt: this.now().toISOString() })
        .where(
          and(
            eq(canvasDocGrants.grantId, evidence.grantId),
            eq(canvasDocGrants.documentId, evidence.documentId),
            isNull(canvasDocGrants.revokedAt)
          )
        )
        .run();
    });
  }
  /** Non-human sender stamped solely from the linked durable document identity. */
  sender(receipt: SessionMessageAcceptanceReceipt): string {
    const batch = this.store.getBatch(receipt.sourceId);
    if (
      !batch ||
      batch.admissionReceiptId !== receipt.id ||
      batch.generation !== receipt.sourceGeneration
    )
      refuseDocBatch();
    return `relay.doc.${batch.documentId}`;
  }
  /** Correlate an observed projected start, without claiming durable runtime admission. */
  onTurnStarted(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    seq: number,
    now: string
  ): undefined {
    this.transition(tx, receipt, 'turn_started', now, `projected:${seq}`);
  }
  /** Only the coordinator's correlated successful settlement proves completion. */
  onSettled(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    outcome: 'ok' | 'failed',
    now: string
  ): undefined {
    this.transition(tx, receipt, outcome === 'ok' ? 'turn_done' : 'failed', now);
  }
  /** Stop accepted work after a final refusal without reopening its immutable generation. */
  onCancelled(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    reason: string,
    now: string
  ): undefined {
    this.transition(tx, receipt, 'cancelled', now, reason);
  }
  /** Preserve unknown effect evidence and prevent automatic retry. */
  onOutcomeUnknown(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    reason: string,
    now: string
  ): undefined {
    this.transition(tx, receipt, 'in_doubt', now, reason);
  }
  private transition(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    status: 'turn_started' | 'turn_done' | 'failed' | 'cancelled' | 'in_doubt',
    now: string,
    reason?: string
  ): void {
    const batch = this.store.getBatch(receipt.sourceId, tx);
    if (
      !batch ||
      batch.generation !== receipt.sourceGeneration ||
      batch.admissionReceiptId !== receipt.id
    )
      refuseDocBatch('document_batch_changed');
    tx.update(canvasDocBatches)
      .set({ status, errorCode: reason ?? null, updatedAt: now })
      .where(eq(canvasDocBatches.batchId, batch.batchId))
      .run();
    tx.update(canvasDocDeliveries)
      .set({ status, reason: reason ?? null, updatedAt: now })
      .where(
        and(
          eq(canvasDocDeliveries.batchId, batch.batchId),
          inArray(canvasDocDeliveries.eventId, batch.inputEventIds)
        )
      )
      .run();
    // A closed channel retains its tombstone; completion cannot reopen its log.
    if (this.store.getChannel(batch.documentId, tx)?.closedAt === null)
      appendDocStatus(
        this.store,
        tx,
        batch.documentId,
        { batchId: batch.batchId, status, receiptId: receipt.id },
        now
      );
  }
  private readReceiptAuthority(
    tx: DbTransaction,
    batch: DocBatchRow,
    receipt: SessionMessageAcceptanceReceipt
  ) {
    let authority;
    try {
      authority = readDocBatchAuthority(this.store, this.grants, tx, batch);
    } catch (error) {
      if (
        error instanceof CanvasAppManifestError ||
        (error instanceof DocRouteGrantError && error.code === 'MANIFEST_CHANGED')
      ) {
        const refusal = new Error('Document app authority changed during ownership recovery.');
        this.rebindFailures.set(refusal, {
          receipt,
          grantId: batch.grantId,
          documentId: batch.documentId,
          scope: `session:${receipt.sessionId}`,
        });
        throw refusal;
      }
      throw error;
    }
    return authority;
  }
  private requireBatch(
    tx: DbTransaction,
    ref: DocBatchSourceRef,
    statuses: DocBatchRow['status'][]
  ): DocBatchRow {
    const batch = this.store.getBatch(ref.batchId, tx);
    if (!batch || batch.generation !== ref.sourceGeneration || !statuses.includes(batch.status))
      refuseDocBatch('document_batch_changed');
    return batch;
  }
}
function receiptRef(receipt: SessionMessageAcceptanceReceipt): DocBatchSourceRef {
  if (receipt.sourceKind !== 'document_event_batch') refuseDocBatch('document_batch_changed');
  return {
    kind: 'document_event_batch',
    batchId: receipt.sourceId,
    sourceGeneration: receipt.sourceGeneration,
  };
}

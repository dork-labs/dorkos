/** Compose document batches with the single existing protected session queue. */
import type { Db } from '@dorkos/db';
import type { CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';
import { MessageQueueStore } from '../../../session/message-queue-store.js';
import {
  PrivateSessionMessageAcceptanceService,
  type PrivateSessionMessageSourceAdapter,
  type PrivateSessionMessageAcceptance,
} from '../../../session/private-messages/acceptance.js';
import { DocumentEventBatchSource } from './batch-source.js';
import { docBatchLabel, refuseDocBatch } from './batch-authority.js';
import { admitBatchSlice } from '../coalescer.js';
import { DOC_EVENTS_PROMPT_BYTES } from '../prompt.js';
import type { DocChannelGrants } from '../grants.js';
import type { DocChannelLifecycle } from '../lifecycle.js';
import type { DocChannelStore } from '../store.js';

/** Real authority and existing queue are mandatory; no default authorization is manufactured. */
export interface DocBatchAdmissionOptions {
  db: Db;
  store: DocChannelStore;
  grants: DocChannelGrants;
  lifecycle: DocChannelLifecycle;
  queue: MessageQueueStore;
  bootEpoch: string;
  existingSources?: readonly PrivateSessionMessageSourceAdapter[];
  now?: () => Date;
}
/** Fixed source registration and atomic immutable slice admission. */
export class DocBatchAdmission {
  readonly source: DocumentEventBatchSource;
  readonly acceptance: PrivateSessionMessageAcceptanceService;
  private readonly now: () => Date;
  /** Register the document source beside existing protected sources, on their existing queue. */
  constructor(private readonly options: DocBatchAdmissionOptions) {
    this.now = options.now ?? (() => new Date());
    this.source = new DocumentEventBatchSource(options.store, options.grants);
    this.acceptance = new PrivateSessionMessageAcceptanceService(
      options.db,
      options.queue,
      [...(options.existingSources ?? []), this.source],
      options.bootEpoch,
      this.now
    );
  }
  /** Run before installing/resuming any queue pump, after runtime binding recovery. */
  initializeBoot(): number {
    this.options.lifecycle.attachReceiptCoordinator(this.acceptance);
    this.options.lifecycle.recoverIdentityMoves();
    return this.acceptance.recoverUnobservedAttempts();
  }
  /** Refresh outside the transaction, then select and accept exactly one immutable generation. */
  admit(batchId: string): PrivateSessionMessageAcceptance {
    const { store, grants } = this.options;
    const initial = store.getBatch(batchId);
    if (!initial) refuseDocBatch('document_batch_missing');
    const ref = {
      kind: 'document_event_batch' as const,
      batchId,
      sourceGeneration: initial.generation,
    };
    this.source.refresh(ref);
    if (initial.status === 'accepted') return this.acceptance.accept(ref);
    try {
      const selection = store.transaction((tx) => {
        const batch = store.getBatch(batchId, tx);
        if (!batch || batch.generation !== initial.generation)
          refuseDocBatch('document_batch_changed');
        const { grant } = grants.revalidateBatchGrant(batch, tx);
        const route = grant.normalizedRoute as CanvasChannelRoute;
        if (route.turn.mode === 'none' || !batch.scope.startsWith('session:'))
          refuseDocBatch('document_session_target_required');
        return { maxBatch: route.turn.maxBatch, label: docBatchLabel(tx, batch) };
      });
      // A canonical session name may grow to the contract's 200 escaped characters.
      // Reserve that growth now so an accepted slice always remains within the renderer cap.
      return admitBatchSlice(
        store,
        batchId,
        selection.maxBatch,
        selection.label,
        this.now().toISOString(),
        (_tx, slice) =>
          this.acceptance.accept({ ...ref, sourceGeneration: slice.batch.generation }),
        DOC_EVENTS_PROMPT_BYTES - 1200
      );
    } catch (error) {
      this.source.refresh(ref);
      throw error;
    }
  }
}

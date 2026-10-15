import type {
  canvasDocChannels,
  canvasDocEvents,
  canvasDocGrants,
  canvasDocBatches,
  canvasDocDeliveries,
  canvasDocIdentityIntents,
  canvasDocWriteIntents,
  Db,
  DbTransaction,
} from '@dorkos/db';
import type { DocChannelStore } from '../store.js';

export type EventInput = Omit<typeof canvasDocEvents.$inferInsert, 'docSeq'>;

/** A stored channel, independent of the physical canvas document. */
export type DocChannelRow = typeof canvasDocChannels.$inferSelect;
/** One durable event, ordered within its document. */
export type DocEventRow = typeof canvasDocEvents.$inferSelect;
/** Stable route authority evidence. */
export type DocGrantRow = typeof canvasDocGrants.$inferSelect;
/** An immutable or pending delivery batch. */
export type DocBatchRow = typeof canvasDocBatches.$inferSelect;
/** One input's route outcome, retained after coalescing. */
export type DocDeliveryRow = typeof canvasDocDeliveries.$inferSelect;
/** Recoverable ownership movement evidence. */
export type DocIdentityIntentRow = typeof canvasDocIdentityIntents.$inferSelect;
/** Recoverable filesystem operation evidence. */
export type DocWriteIntentRow = typeof canvasDocWriteIntents.$inferSelect;

/** A mutation addressed a channel that no longer accepts writes. */
export class DocChannelClosedError extends Error {
  readonly code = 'DOC_CHANNEL_CLOSED';
  /** Build a safe channel closure refusal. */
  constructor(readonly documentId: string) {
    super('The document channel is closed or absent.');
    this.name = 'DocChannelClosedError';
  }
}

/** A revision compare-and-set did not match current state. */
export class DocChannelStateConflictError extends Error {
  readonly code = 'DOC_CHANNEL_STATE_CONFLICT';
  /** Build a safe optimistic concurrency refusal. */
  constructor() {
    super('The document state revision changed.');
    this.name = 'DocChannelStateConflictError';
  }
}

/** Shape of the existing constructor-private captured dependency tuple; no state or registrar. */
export interface OriginalDocStoreBindings {
  db: Db;
  append: (input: EventInput, tx: DbTransaction) => DocEventRow;
  relay: Readonly<Pick<DocChannelStore, 'transaction' | 'getBatch' | 'getEvent'>>;
  downstream: Readonly<
    Pick<
      DocChannelStore,
      'transaction' | 'getChannel' | 'getBatch' | 'getEvent' | 'listDeliveries' | 'appendEvent'
    >
  >;
  grant: Readonly<
    Pick<DocChannelStore, 'transaction' | 'getChannel' | 'insertGrant' | 'getGrant' | 'revokeGrant'>
  >;
}

/** Exact existing acquireLease input contract. */
export interface DocBatchLeaseInput {
  batchId: string;
  generation: string;
  status: DocBatchRow['status'];
  now: string;
  leaseUntil: string;
}

/** Exact existing transitionBatch input contract. */
export interface DocBatchTransitionInput {
  batchId: string;
  generation: string;
  attempt: number;
  expectedStatus: DocBatchRow['status'];
  status: DocBatchRow['status'];
  updatedAt: string;
}

/** Exact existing replaceState input contract. */
export interface DocStateReplacementInput {
  documentId: string;
  expectedStateRev: number;
  state: DocChannelRow['state'];
  event: Omit<typeof canvasDocEvents.$inferInsert, 'docSeq'>;
}

/** Exact existing updatePendingBatch input contract. */
export interface DocPendingBatchUpdateInput {
  batchId: string;
  generation: string;
  status: 'pending' | 'waiting';
  inputEventIds: DocBatchRow['inputEventIds'];
  effectivePayload: DocBatchRow['effectivePayload'];
  updatedAt: string;
}

/** Exact existing updateDelivery input contract. */
export interface DocDeliveryUpdateInput {
  documentId: string;
  eventId: string;
  routeId: string;
  expectedStatus: DocDeliveryRow['status'];
  changes: Partial<
    Omit<typeof canvasDocDeliveries.$inferInsert, 'documentId' | 'eventId' | 'routeId'>
  >;
}

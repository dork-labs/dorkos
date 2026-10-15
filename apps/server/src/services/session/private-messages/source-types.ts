/** Closed protected admission sources and their synchronous final authority callbacks. */
import type { DbTransaction, SessionMessageAcceptanceReceipt } from '@dorkos/db';
import type { CanvasChannelDocEventsContext } from '@dorkos/shared/canvas-channel-schemas';
import type { QueuedMessageRecord } from '../message-queue-store.js';
/** A protected source that may create one private session follow-up. */
export type PrivateSessionMessageSourceRef =
  | {
      kind: 'connector_agent_request';
      requestId: string;
      sourceGeneration: string;
      /** Opaque claim credential conditionally consumed by the fixed adapter. */
      resumeToken: string;
    }
  | {
      kind: 'connector_event';
      inboxId: string;
      sourceGeneration: string;
      /** Current lease owner conditionally consumed by the fixed adapter. */
      leaseOwner: string;
    }
  | { kind: 'document_event_batch'; batchId: string; sourceGeneration: string };

/** Trusted source data returned while the acceptance transaction is open. */
export interface PrivateSessionMessageDraft {
  sourceKind: PrivateSessionMessageSourceRef['kind'];
  sourceId: string;
  sourceGeneration: string;
  sessionId: string;
  agentId: string;
  originRuntime: string;
  originAgentPath: string;
  originAuthorityDigest: string;
  /** Safe text clients may see while the protected content stays at its source. */
  queuePlaceholder: string;
}

/** Protected content resolved in memory before the final synchronous claim. */
export interface PreparedPrivateSessionMessage {
  sourceKind: PrivateSessionMessageSourceRef['kind'];
  sourceId: string;
  sourceGeneration: string;
  content: string;
  /** Server-derived document context, never queue text or caller-supplied context. */
  docEvents?: CanvasChannelDocEventsContext;
}

/** Server-owned adapter for one member of {@link PrivateSessionMessageSourceRef}. */
export interface PrivateSessionMessageSourceAdapter<
  TRef extends PrivateSessionMessageSourceRef = PrivateSessionMessageSourceRef,
> {
  readonly kind: TRef['kind'];
  /** Consume the source and return trusted routing data in the caller's transaction. */
  consume(tx: DbTransaction, ref: TRef, now: string): PrivateSessionMessageDraft;
  /** Resolve or decrypt minimized content in memory; it is never written to the queue. */
  prepare(receipt: SessionMessageAcceptanceReceipt): Promise<PreparedPrivateSessionMessage>;
  /** Recognize source-owned authority denials; unknown failures remain retryable before claim. */
  isPreclaimRefusal?(error: unknown, receipt: SessionMessageAcceptanceReceipt): boolean;
  /** Revalidate exact origin, destination, source generation, and authority. */
  revalidate(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    prepared: PreparedPrivateSessionMessage,
    now: string
  ): void | PrivateSessionMessageTurnInput | PrivateSessionMessageSourceClaimDecision;
  /** Durable document budget deadline; a timer conveys no authority. */
  dispatchNotBefore?(receipt: SessionMessageAcceptanceReceipt): string | undefined;
  /** Link source admission to the actual generated receipt in the same transaction. */
  onAccepted?(tx: DbTransaction, receipt: SessionMessageAcceptanceReceipt, now: string): undefined;
  /** Server-stamped non-human identity for the existing private queue pump. */
  sender?(receipt: SessionMessageAcceptanceReceipt): string;
  /** Source-owned exact authority rebind; absence refuses canonical movement. */
  rebindAccepted?(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    toSessionId: string,
    now: string,
    previousSourceScope?: string
  ): string | undefined;
  /** Trusted reduction-only recovery hook; called only after ownership rollback. */
  onRebindFailed?(error: unknown): undefined;
  /** Record an observed turn start while its queue row is retired atomically. */
  onTurnStarted?(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    seq: number,
    now: string
  ): void;
  /** Record truthful terminal delivery and purge protected source content when allowed. */
  onSettled?(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    outcome: 'ok' | 'failed',
    now: string
  ): void;
  /** Record a terminal cancellation before any runtime effect. */
  onCancelled?(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    reason: string,
    now: string
  ): void;
  /** Record an ambiguous effect without making the source retryable. */
  onOutcomeUnknown?(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    reason: string,
    now: string
  ): void;
}

/** Result of accepting a private source into the durable session queue. */
export interface PrivateSessionMessageAcceptance {
  receipt: SessionMessageAcceptanceReceipt;
  /** Present while the accepted message is still waiting. */
  queueRecord?: QueuedMessageRecord;
  created: boolean;
}

/** Claim returned exactly once for the first runtime effect. */
export interface ClaimedPrivateSessionMessage extends PrivateSessionMessageTurnInput {
  deferred?: false;
  receiptId: string;
  dispatchAttemptId: string;
}

/** Final synchronous source result immediately before the runtime effect. */
export interface PrivateSessionMessageTurnInput {
  content: string;
  docEvents?: CanvasChannelDocEventsContext;
}

/** Actual runtime invocation bound by the private dispatcher, independent of prepared content. */
export interface PrivateSessionMessageDispatchBinding {
  sessionId: string;
  runtime: string;
}

/** A source may hold accepted work without claiming or cancelling its original receipt. */
export type PrivateSessionMessageSourceClaimDecision =
  | { decision: 'admit'; input: PrivateSessionMessageTurnInput }
  | { decision: 'defer'; reason: string; nextEligibleAt: string }
  | { decision: 'refuse'; code: string; message: string };
/** Deferred claims carry no dispatch attempt or runtime input. */
export interface DeferredPrivateSessionMessage {
  deferred: true;
  receiptId: string;
  reason: string;
  nextEligibleAt: string;
  dispatchAttemptId?: never;
  content?: never;
  docEvents?: never;
}
/** Ordinary protected sources keep their existing claimed result. */
export type PrivateSessionMessageClaimResult =
  ClaimedPrivateSessionMessage | DeferredPrivateSessionMessage;

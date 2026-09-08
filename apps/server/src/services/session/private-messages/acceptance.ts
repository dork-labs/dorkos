/**
 * Durable acceptance and dispatch preflight for private session messages.
 *
 * A caller supplies only a closed source reference. A server-owned adapter
 * consumes that source inside the same SQLite transaction that inserts the
 * safe queue placeholder and stable receipt. The source adapter resolves any
 * protected content later, in memory, and revalidates authority synchronously
 * in the final compare-and-set immediately before the runtime is invoked.
 *
 * @module services/session/private-messages/acceptance
 */
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  sessionMessageAcceptanceReceipts,
  type Db,
  type DbTransaction,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';
import type { MessageQueueStore, QueuedMessageRecord } from '../message-queue-store.js';

let sharedService: PrivateSessionMessageAcceptanceService | undefined;

/** Install the process-wide protected-message coordinator at the composition root. */
export function setPrivateSessionMessageAcceptanceService(
  service: PrivateSessionMessageAcceptanceService | undefined
): void {
  sharedService = service;
}

/** Read the protected-message coordinator, if this host configured one. */
export function getPrivateSessionMessageAcceptanceService():
  PrivateSessionMessageAcceptanceService | undefined {
  return sharedService;
}

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
    };

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
  /** Revalidate exact origin, destination, source generation, and authority. */
  revalidate(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    prepared: PreparedPrivateSessionMessage,
    now: string
  ): void;
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
export interface ClaimedPrivateSessionMessage {
  receiptId: string;
  dispatchAttemptId: string;
  content: string;
}

/**
 * Error raised when protected content cannot be accepted or dispatched safely.
 */
export class PrivateSessionMessageRefusalError extends Error {
  /** Stable internal reason code suitable for logs and tests. */
  readonly code: string;

  /**
   * Build a refusal without exposing protected source content.
   *
   * @param code - Stable internal reason code
   * @param message - Safe diagnostic detail
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PrivateSessionMessageRefusalError';
    this.code = code;
  }
}

/** Durable private-source acceptance and exactly-once dispatch coordinator. */
export class PrivateSessionMessageAcceptanceService {
  private readonly adapters = new Map<
    PrivateSessionMessageSourceRef['kind'],
    PrivateSessionMessageSourceAdapter
  >();

  /**
   * Build the coordinator from a fixed, composition-root-owned adapter set.
   *
   * @param db - Local SQLite database
   * @param queue - Existing durable session queue
   * @param sourceAdapters - Closed adapters for the supported source union
   * @param bootEpoch - Stable identity of this server process
   * @param now - Clock used for durable timestamps
   */
  constructor(
    private readonly db: Db,
    private readonly queue: MessageQueueStore,
    sourceAdapters: readonly PrivateSessionMessageSourceAdapter[],
    private readonly bootEpoch: string,
    private readonly now: () => Date = () => new Date()
  ) {
    for (const adapter of sourceAdapters) {
      if (this.adapters.has(adapter.kind)) {
        throw new Error(`Duplicate private session source adapter: ${adapter.kind}`);
      }
      this.adapters.set(adapter.kind, adapter);
    }
  }

  /**
   * Consume a protected source and accept its safe placeholder atomically.
   * Repeating the same immutable source identity returns its existing receipt.
   *
   * @param ref - Opaque source reference; no destination or message content
   */
  accept(ref: PrivateSessionMessageSourceRef): PrivateSessionMessageAcceptance {
    const adapter = this.adapterFor(ref.kind);
    const now = this.now().toISOString();
    return this.db.transaction((tx) => {
      const sourceId = sourceIdOf(ref);
      const existing = tx
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(
          and(
            eq(sessionMessageAcceptanceReceipts.sourceKind, ref.kind),
            eq(sessionMessageAcceptanceReceipts.sourceId, sourceId),
            eq(sessionMessageAcceptanceReceipts.sourceGeneration, ref.sourceGeneration)
          )
        )
        .get();
      if (existing) {
        const queueRecord = this.queue.get(existing.queueMessageId);
        return { receipt: existing, ...(queueRecord ? { queueRecord } : {}), created: false };
      }

      const draft = adapter.consume(tx, ref as never, now);
      if (
        draft.sourceKind !== ref.kind ||
        draft.sourceId !== sourceId ||
        draft.sourceGeneration !== ref.sourceGeneration
      ) {
        throw new PrivateSessionMessageRefusalError(
          'source_identity_mismatch',
          'The protected source identity changed while it was being accepted.'
        );
      }
      const receiptId = randomUUID();
      const queueMessageId = randomUUID();
      const queueRecord = this.queue.enqueue(
        {
          id: queueMessageId,
          sessionId: draft.sessionId,
          content: draft.queuePlaceholder,
          clientId: `system:${draft.sourceKind}`,
          disposition: 'queue',
        },
        tx
      );
      const receipt = {
        id: receiptId,
        sourceKind: draft.sourceKind,
        sourceId: draft.sourceId,
        sourceGeneration: draft.sourceGeneration,
        queueMessageId,
        sessionId: draft.sessionId,
        agentId: draft.agentId,
        originRuntime: draft.originRuntime,
        originAgentPath: draft.originAgentPath,
        originAuthorityDigest: draft.originAuthorityDigest,
        state: 'accepted' as const,
        acceptedAt: now,
        dispatchAttemptId: null,
        dispatchBootEpoch: null,
        dispatchClaimedAt: null,
        turnStartSeq: null,
        turnStartedAt: null,
        settledAt: null,
        settleOutcome: null,
        cancellationCode: null,
      } satisfies SessionMessageAcceptanceReceipt;
      tx.insert(sessionMessageAcceptanceReceipts).values(receipt).run();
      return { receipt, queueRecord, created: true };
    });
  }

  /** Resolve minimized protected content in memory before the final claim. */
  async prepare(receiptId: string): Promise<PreparedPrivateSessionMessage> {
    const receipt = this.requireReceipt(receiptId);
    if (receipt.state !== 'accepted') {
      throw new PrivateSessionMessageRefusalError(
        'receipt_not_accepted',
        `Private message receipt is ${receipt.state}.`
      );
    }
    return this.adapterFor(receipt.sourceKind).prepare(receipt);
  }

  /**
   * Revalidate and exclusively claim a dispatch immediately before runtime use.
   * No asynchronous work may occur between this return and the first effect.
   */
  claim(receiptId: string, prepared: PreparedPrivateSessionMessage): ClaimedPrivateSessionMessage {
    const now = this.now().toISOString();
    return this.db.transaction((tx) => {
      const receipt = tx
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, receiptId))
        .get();
      if (!receipt || receipt.state !== 'accepted') {
        throw new PrivateSessionMessageRefusalError(
          'dispatch_already_claimed',
          'This private message is no longer available for dispatch.'
        );
      }
      if (
        prepared.sourceKind !== receipt.sourceKind ||
        prepared.sourceId !== receipt.sourceId ||
        prepared.sourceGeneration !== receipt.sourceGeneration
      ) {
        throw new PrivateSessionMessageRefusalError(
          'prepared_source_mismatch',
          'The prepared private message does not match its durable source receipt.'
        );
      }
      this.adapterFor(receipt.sourceKind).revalidate(tx, receipt, prepared, now);
      const dispatchAttemptId = randomUUID();
      const changed = tx
        .update(sessionMessageAcceptanceReceipts)
        .set({
          state: 'dispatching',
          dispatchAttemptId,
          dispatchBootEpoch: this.bootEpoch,
          dispatchClaimedAt: now,
        })
        .where(
          and(
            eq(sessionMessageAcceptanceReceipts.id, receiptId),
            eq(sessionMessageAcceptanceReceipts.state, 'accepted')
          )
        )
        .run().changes;
      if (changed !== 1) {
        throw new PrivateSessionMessageRefusalError(
          'dispatch_claim_raced',
          'Another dispatcher claimed this private message first.'
        );
      }
      return { receiptId, dispatchAttemptId, content: prepared.content };
    });
  }

  /** Advance a claimed receipt and delete its queue row in one transaction. */
  markTurnStarted(receiptId: string, seq: number): void {
    const now = this.now().toISOString();
    this.db.transaction((tx) => {
      const receipt = tx
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, receiptId))
        .get();
      if (!receipt || receipt.state !== 'dispatching') return;
      this.queue.remove(receipt.queueMessageId, tx);
      this.adapterFor(receipt.sourceKind).onTurnStarted?.(tx, receipt, seq, now);
      tx.update(sessionMessageAcceptanceReceipts)
        .set({ state: 'turn_started', turnStartSeq: seq, turnStartedAt: now })
        .where(
          and(
            eq(sessionMessageAcceptanceReceipts.id, receiptId),
            eq(sessionMessageAcceptanceReceipts.state, 'dispatching')
          )
        )
        .run();
    });
  }

  /** Record the terminal outcome of a turn that definitely started. */
  settle(receiptId: string, outcome: 'ok' | 'failed'): void {
    const now = this.now().toISOString();
    this.db.transaction((tx) => {
      const receipt = tx
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, receiptId))
        .get();
      if (!receipt || receipt.state !== 'turn_started') return;
      this.adapterFor(receipt.sourceKind).onSettled?.(tx, receipt, outcome, now);
      tx.update(sessionMessageAcceptanceReceipts)
        .set({
          state: 'settled',
          settledAt: now,
          settleOutcome: outcome === 'ok' ? 'completed' : 'failed',
        })
        .where(
          and(
            eq(sessionMessageAcceptanceReceipts.id, receiptId),
            eq(sessionMessageAcceptanceReceipts.state, 'turn_started')
          )
        )
        .run();
    });
  }

  /** Quarantine a claimed attempt that failed before a turn start was observed. */
  markOutcomeUnknown(receiptId: string, cancellationCode: string): void {
    this.db.transaction((tx) => {
      const receipt = tx
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, receiptId))
        .get();
      if (!receipt || receipt.state !== 'dispatching') return;
      this.queue.remove(receipt.queueMessageId, tx);
      this.adapterFor(receipt.sourceKind).onOutcomeUnknown?.(
        tx,
        receipt,
        cancellationCode,
        this.now().toISOString()
      );
      tx.update(sessionMessageAcceptanceReceipts)
        .set({
          state: 'outcome_unknown',
          cancellationCode,
          settledAt: this.now().toISOString(),
        })
        .where(
          and(
            eq(sessionMessageAcceptanceReceipts.id, receiptId),
            eq(sessionMessageAcceptanceReceipts.state, 'dispatching')
          )
        )
        .run();
    });
  }

  /** Cancel an accepted message after a final authority refusal or source expiry. */
  cancel(receiptId: string, cancellationCode: string): void {
    this.db.transaction((tx) => {
      const receipt = tx
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, receiptId))
        .get();
      if (!receipt || receipt.state !== 'accepted') return;
      this.queue.remove(receipt.queueMessageId, tx);
      this.adapterFor(receipt.sourceKind).onCancelled?.(
        tx,
        receipt,
        cancellationCode,
        this.now().toISOString()
      );
      tx.update(sessionMessageAcceptanceReceipts)
        .set({ state: 'cancelled', cancellationCode, settledAt: this.now().toISOString() })
        .where(eq(sessionMessageAcceptanceReceipts.id, receiptId))
        .run();
    });
  }

  /**
   * Quarantine attempts a previous boot may have sent. They are never replayed.
   *
   * @returns Number of receipts moved to `outcome_unknown`
   */
  recoverUnobservedAttempts(): number {
    const rows = this.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(inArray(sessionMessageAcceptanceReceipts.state, ['dispatching', 'turn_started']))
      .all()
      .filter((row) => row.dispatchBootEpoch !== this.bootEpoch);
    if (rows.length === 0) return 0;
    return this.db.transaction((tx) => {
      let changed = 0;
      for (const row of rows) {
        this.queue.remove(row.queueMessageId, tx);
        this.adapterFor(row.sourceKind).onOutcomeUnknown?.(
          tx,
          row,
          'server_restarted_after_dispatch_claim',
          this.now().toISOString()
        );
        changed += tx
          .update(sessionMessageAcceptanceReceipts)
          .set({
            state: 'outcome_unknown',
            cancellationCode: 'server_restarted_after_dispatch_claim',
            settledAt: this.now().toISOString(),
          })
          .where(
            and(
              eq(sessionMessageAcceptanceReceipts.id, row.id),
              inArray(sessionMessageAcceptanceReceipts.state, ['dispatching', 'turn_started'])
            )
          )
          .run().changes;
      }
      return changed;
    });
  }

  /** Find any private receipt by queue id so generic adoption never touches it. */
  findByQueueMessageId(messageId: string): SessionMessageAcceptanceReceipt | undefined {
    return this.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.queueMessageId, messageId))
      .get();
  }

  /** List accepted receipts for one session in acceptance order. */
  listAccepted(sessionId: string): SessionMessageAcceptanceReceipt[] {
    return this.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(
        and(
          eq(sessionMessageAcceptanceReceipts.sessionId, sessionId),
          eq(sessionMessageAcceptanceReceipts.state, 'accepted')
        )
      )
      .orderBy(sessionMessageAcceptanceReceipts.acceptedAt)
      .all();
  }

  /** List one stable keyset page of sessions with accepted messages awaiting dispatch. */
  listAcceptedSessionIds(limit = 100, afterSessionId?: string): string[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.db
      .selectDistinct({ sessionId: sessionMessageAcceptanceReceipts.sessionId })
      .from(sessionMessageAcceptanceReceipts)
      .where(
        and(
          eq(sessionMessageAcceptanceReceipts.state, 'accepted'),
          afterSessionId
            ? gt(sessionMessageAcceptanceReceipts.sessionId, afterSessionId)
            : undefined
        )
      )
      .orderBy(asc(sessionMessageAcceptanceReceipts.sessionId))
      .limit(boundedLimit)
      .all()
      .map((row) => row.sessionId);
  }

  private requireReceipt(receiptId: string): SessionMessageAcceptanceReceipt {
    const receipt = this.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, receiptId))
      .get();
    if (!receipt) {
      throw new PrivateSessionMessageRefusalError(
        'receipt_not_found',
        'Private message receipt was not found.'
      );
    }
    return receipt;
  }

  private adapterFor(
    kind: PrivateSessionMessageSourceRef['kind']
  ): PrivateSessionMessageSourceAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new PrivateSessionMessageRefusalError(
        'source_adapter_unavailable',
        `Private session source adapter is unavailable: ${kind}`
      );
    }
    return adapter;
  }
}

function sourceIdOf(ref: PrivateSessionMessageSourceRef): string {
  return ref.kind === 'connector_agent_request' ? ref.requestId : ref.inboxId;
}

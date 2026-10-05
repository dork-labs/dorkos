import {
  CanvasChannelDeclarationSchema,
  type CanvasChannelDeclaration,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../core/approvals/approval-input-hash.js';
/** Atomic document closure and recoverable canonical ownership movement. */
import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  inArray,
  isNull,
  sql,
  canvasDocuments,
  canvasDocChannels,
  canvasDocGrants,
  canvasDocBatches,
  canvasDocDeliveries,
  canvasDocIdentityIntents,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  sessionMetadata,
  agents,
  type Db,
  type DbTransaction,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';
import { assertIdentityMoveTarget } from './identity/identity-target.js';
import { DocChannelStore } from './store.js';
import { QUEUE_POSITION_STEP } from '../../session/message-queue-store.js';

/** Source-owned canonical receipt rebinding, inside the document move's transaction. */
export interface DocChannelReceiptRebinder {
  /** Suspend an exact authenticated source observation only after SQLite ownership rollback. */
  onRebindFailed?(error: unknown): undefined;
  /** Revalidate and rebind one accepted receipt without changing its source authority. */
  rebindAccepted(tx: DbTransaction, receiptId: string, fromId: string, toId: string): boolean;
}
/** Lifecycle collaborators; no token authority exists until its own implementation arrives. */
export interface DocChannelLifecycleOptions {
  now?: () => string;
  receipts?: DocChannelReceiptRebinder;
  /** Future token storage must revoke inside this same closure transaction. */
  revokeTokens?: (tx: DbTransaction, documentId: string, now: string) => void;
}
/** Server-derived origin and optional declaration for a fresh physical document only. */
export interface DocChannelInitialization {
  declaration?: CanvasChannelDeclaration;
  openerAgentId?: string | null;
}
/** Private identity data sufficient for closure, including unreadable document content. */
export interface DocChannelDocumentIdentity {
  id: string;
  scope: string;
  sourceKey: string | null;
}

export { DocChannelIdentityBlockedError } from './identity/identity-error.js';
import { DocChannelIdentityBlockedError } from './identity/identity-error.js';

/** Synchronous lifecycle operations over the same database used by the document store. */
export class DocChannelLifecycle {
  private readonly store: DocChannelStore;
  private readonly now: () => string;
  #readScopeMoves?: (scope: string) => (typeof canvasDocIdentityIntents.$inferSelect)[];
  #readBlockedIdentity?: (documentId: string) => { id: string } | undefined;
  /** Construct lifecycle policy without enabling any event admission source. */
  constructor(
    private readonly db: Db,
    private readonly options: DocChannelLifecycleOptions = {}
  ) {
    this.store = new DocChannelStore(db);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Backfill log-only identity for documents persisted before channels existed. */
  initializeExistingDocuments(): void {
    this.db.transaction((tx) => {
      const documents = tx
        .select({
          id: canvasDocuments.id,
          scope: canvasDocuments.scope,
          sourceKey: canvasDocuments.sourceKey,
        })
        .from(canvasDocuments)
        .all();
      for (const document of documents) {
        if (
          !tx
            .select({ id: canvasDocChannels.documentId })
            .from(canvasDocChannels)
            .where(eq(canvasDocChannels.documentId, document.id))
            .get()
        )
          this.opened(tx, document);
      }
    });
  }

  /** A retained identity is never reused for a genuinely new document incarnation. */
  freshId(candidate: string): string {
    return this.store.getChannel(candidate) ? randomUUID() : candidate;
  }

  /** Initialize log identity with the physical document in one transaction. */
  opened(
    tx: DbTransaction,
    document: DocChannelDocumentIdentity,
    initialization: DocChannelInitialization = {}
  ): void {
    const now = this.now();
    const declaration = initialization.declaration
      ? CanvasChannelDeclarationSchema.parse(initialization.declaration)
      : undefined;
    const channel = this.store.initialize(
      {
        documentId: document.id,
        scope: document.scope,
        createdAt: now,
        updatedAt: now,
        openerAgentId: initialization.openerAgentId ?? null,
        ...(declaration ? { declaration, declarationHash: hashApprovalInput(declaration) } : {}),
      },
      tx
    );
    if (channel.closedAt !== null || channel.scope !== document.scope)
      throw new Error('A retained document identity cannot be reopened.');
  }

  /** Revoke authority and retain closure evidence before physical deletion. */
  close(tx: DbTransaction, document: DocChannelDocumentIdentity, reason = 'removed'): void {
    this.opened(tx, document);
    const now = this.now();
    this.store.markClosed(document.id, now, { reason, scope: document.scope }, tx);
    tx.update(canvasDocGrants)
      .set({ revokedAt: now })
      .where(and(eq(canvasDocGrants.documentId, document.id), isNull(canvasDocGrants.revokedAt)))
      .run();
    this.options.revokeTokens?.(tx, document.id, now);
    const batches = tx
      .select()
      .from(canvasDocBatches)
      .where(eq(canvasDocBatches.documentId, document.id))
      .all();
    for (const batch of batches) {
      const receipt = this.receipt(tx, batch.admissionReceiptId);
      if (receipt && receipt.state !== 'accepted') continue;
      if (!['pending', 'waiting', 'accepted'].includes(batch.status)) continue;
      if (receipt) {
        tx.delete(sessionMessageQueue)
          .where(eq(sessionMessageQueue.id, receipt.queueMessageId))
          .run();
        tx.update(sessionMessageAcceptanceReceipts)
          .set({ state: 'cancelled', cancellationCode: 'document_closed', settledAt: now })
          .where(
            and(
              eq(sessionMessageAcceptanceReceipts.id, receipt.id),
              eq(sessionMessageAcceptanceReceipts.state, 'accepted')
            )
          )
          .run();
      }
      tx.update(canvasDocBatches)
        .set({
          status: 'cancelled',
          errorCode: 'document_closed',
          leaseUntil: null,
          updatedAt: now,
        })
        .where(eq(canvasDocBatches.batchId, batch.batchId))
        .run();
      tx.update(canvasDocDeliveries)
        .set({ status: 'cancelled', reason: 'document_closed', updatedAt: now })
        .where(eq(canvasDocDeliveries.batchId, batch.batchId))
        .run();
    }
  }

  /** Read durable canonical aliases, refusing ambiguous chains and unfinished ownership. */
  resolveScope(scope: string): string {
    const visited = new Set<string>();
    let current = scope;
    while (!visited.has(current)) {
      visited.add(current);
      if (!this.#readScopeMoves) {
        const query = this.db
          .select()
          .from(canvasDocIdentityIntents)
          .where(eq(canvasDocIdentityIntents.fromScope, sql.placeholder('scope')))
          .prepare();
        const read = query.all.bind(query);
        this.#readScopeMoves = (scope) => read({ scope });
      }
      // Reuse compilation only: every chain step reads the current native rows.
      const moves = this.#readScopeMoves(current);
      if (!moves.length) return current;
      if (moves.some((move) => move.status !== 'applied'))
        throw new DocChannelIdentityBlockedError();
      const destinations = new Set(moves.map((move) => move.toScope));
      if (destinations.size !== 1) throw new DocChannelIdentityBlockedError();
      current = [...destinations][0]!;
    }
    throw new DocChannelIdentityBlockedError();
  }

  /** Refuse new authority while any recoverable ownership operation is incomplete. */
  assertReady(documentId: string): void {
    if (!this.#readBlockedIdentity) {
      const query = this.db
        .select({ id: canvasDocIdentityIntents.intentId })
        .from(canvasDocIdentityIntents)
        .where(
          and(
            eq(canvasDocIdentityIntents.documentId, sql.placeholder('documentId')),
            inArray(canvasDocIdentityIntents.status, ['pending', 'in_doubt', 'failed'])
          )
        )
        .prepare();
      const read = query.get.bind(query);
      this.#readBlockedIdentity = (documentId) => read({ documentId });
    }
    const blocked = this.#readBlockedIdentity(documentId);
    if (blocked) throw new DocChannelIdentityBlockedError();
  }

  /** Attach the fixed coordinator before boot recovery or any admission pump begins. */
  attachReceiptCoordinator(receipts: DocChannelReceiptRebinder): void {
    if (this.options.receipts && this.options.receipts !== receipts)
      throw new Error('Document receipt authority is already configured.');
    this.options.receipts = receipts;
  }

  /** Payload-free repair health; caller must authorize operator access first. */
  health(documentId: string): { status: 'ready' | 'in_doubt'; reasons: string[] } {
    const intents = this.db
      .select()
      .from(canvasDocIdentityIntents)
      .where(
        and(
          eq(canvasDocIdentityIntents.documentId, documentId),
          inArray(canvasDocIdentityIntents.status, ['pending', 'failed', 'in_doubt'])
        )
      )
      .all();
    return intents.length
      ? {
          status: 'in_doubt',
          reasons: [
            ...new Set(intents.map((intent) => intent.errorCode ?? 'identity_move_pending')),
          ],
        }
      : { status: 'ready', reasons: [] };
  }

  /** Persist intent first, then move documents, linked receipts and queues atomically. */
  rekeyScope(from: string, to: string): number {
    if (from === to) return 0;
    if (!from.startsWith('session:') || !to.startsWith('session:'))
      throw new Error('Only session scopes can be rekeyed.');
    const documents = this.db
      .select({
        id: canvasDocuments.id,
        scope: canvasDocuments.scope,
        sourceKey: canvasDocuments.sourceKey,
      })
      .from(canvasDocuments)
      .where(eq(canvasDocuments.scope, from))
      .all();
    if (!documents.length) return 0;
    const now = this.now();
    this.db.transaction((tx) => {
      for (const document of documents) {
        this.opened(tx, document);
        const prior = tx
          .select()
          .from(canvasDocIdentityIntents)
          .where(
            and(
              eq(canvasDocIdentityIntents.documentId, document.id),
              eq(canvasDocIdentityIntents.fromScope, from),
              eq(canvasDocIdentityIntents.toScope, to)
            )
          )
          .get();
        if (!prior)
          this.store.insertIdentityIntent(
            {
              intentId: randomUUID(),
              documentId: document.id,
              fromScope: from,
              toScope: to,
              sourceId: document.id,
              sourceGeneration: 'ownership',
              evidence: { sourceKey: document.sourceKey },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            },
            tx
          );
      }
    });
    try {
      return this.db.transaction((tx) => this.applyMove(tx, from, to, now));
    } catch (error) {
      const code =
        error instanceof DocChannelIdentityBlockedError
          ? 'authority_unverified'
          : 'identity_move_failed';
      this.db
        .update(canvasDocIdentityIntents)
        .set({ status: 'failed', errorCode: code, updatedAt: now })
        .where(
          and(
            eq(canvasDocIdentityIntents.fromScope, from),
            eq(canvasDocIdentityIntents.toScope, to),
            inArray(canvasDocIdentityIntents.status, ['pending', 'failed'])
          )
        )
        .run();
      this.options.receipts?.onRebindFailed?.(error);
      throw error;
    }
  }

  /** Repair pending/failed intents before a caller starts any admission pump. */
  recoverIdentityMoves(): void {
    const intents = this.db
      .select()
      .from(canvasDocIdentityIntents)
      .where(inArray(canvasDocIdentityIntents.status, ['pending', 'failed']))
      .all();
    const scopes = new Map(intents.map((intent) => [intent.fromScope, intent.toScope]));
    for (const [from, to] of scopes) {
      try {
        this.rekeyScope(from, to);
      } catch {
        /* Durable blocked health remains; never start this document. */
      }
    }
  }

  private applyMove(tx: DbTransaction, from: string, to: string, now: string): number {
    const fromId = from.slice('session:'.length);
    const toId = to.slice('session:'.length);
    const documents = tx
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.scope, from))
      .all();
    let uncertain = false;
    for (const document of documents) {
      if (
        document.sourceKey !== null &&
        tx
          .select({ id: canvasDocuments.id })
          .from(canvasDocuments)
          .where(
            and(eq(canvasDocuments.scope, to), eq(canvasDocuments.sourceKey, document.sourceKey))
          )
          .get()
      )
        throw new Error('Document source identity collision.');
      assertIdentityMoveTarget(tx, document.id, fromId, toId);
    }
    for (const document of documents) {
      tx.update(canvasDocBatches)
        .set({ scope: to, updatedAt: now })
        .where(eq(canvasDocBatches.documentId, document.id))
        .run();
      tx.update(canvasDocGrants)
        .set({ targetSessionId: toId })
        .where(
          and(
            eq(canvasDocGrants.documentId, document.id),
            eq(canvasDocGrants.targetSessionId, fromId)
          )
        )
        .run();
      tx.update(canvasDocChannels)
        .set({ scope: to, updatedAt: now })
        .where(eq(canvasDocChannels.documentId, document.id))
        .run();
    }
    const changed = tx
      .update(canvasDocuments)
      .set({ scope: to })
      .where(eq(canvasDocuments.scope, from))
      .run().changes;
    tx.update(canvasDocIdentityIntents)
      .set({
        status: 'applied',
        errorCode: null,
        updatedAt: now,
      })
      .where(
        and(eq(canvasDocIdentityIntents.fromScope, from), eq(canvasDocIdentityIntents.toScope, to))
      )
      .run();
    // Uncommitted canonical state permits the source to revalidate real grant authority.
    for (const document of documents) {
      const batches = tx
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.documentId, document.id))
        .all();
      for (const batch of batches) {
        const receipt = this.receipt(tx, batch.admissionReceiptId);
        if (batch.admissionReceiptId && !receipt) throw new DocChannelIdentityBlockedError();
        if (receipt?.state === 'accepted') {
          if (
            receipt.sessionId !== fromId ||
            !this.sameTarget(tx, receipt, toId) ||
            !this.options.receipts?.rebindAccepted(tx, receipt.id, fromId, toId)
          )
            throw new DocChannelIdentityBlockedError();
          this.moveQueue(tx, receipt, fromId, toId);
        } else if (
          receipt &&
          ['dispatching', 'turn_started', 'outcome_unknown'].includes(receipt.state)
        ) {
          uncertain = true;
          tx.update(canvasDocBatches)
            .set({ status: 'in_doubt', errorCode: 'identity_changed_after_claim', updatedAt: now })
            .where(eq(canvasDocBatches.batchId, batch.batchId))
            .run();
          tx.update(canvasDocDeliveries)
            .set({ status: 'in_doubt', reason: 'identity_changed_after_claim', updatedAt: now })
            .where(eq(canvasDocDeliveries.batchId, batch.batchId))
            .run();
        }
      }
    }
    tx.update(canvasDocIdentityIntents)
      .set({
        status: uncertain ? 'in_doubt' : 'applied',
        errorCode: uncertain ? 'identity_changed_after_claim' : null,
        updatedAt: now,
      })
      .where(
        and(eq(canvasDocIdentityIntents.fromScope, from), eq(canvasDocIdentityIntents.toScope, to))
      )
      .run();
    return changed;
  }

  private receipt(
    tx: DbTransaction,
    id: string | null
  ): SessionMessageAcceptanceReceipt | undefined {
    return id === null
      ? undefined
      : tx
          .select()
          .from(sessionMessageAcceptanceReceipts)
          .where(eq(sessionMessageAcceptanceReceipts.id, id))
          .get();
  }
  private sameTarget(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    sessionId: string
  ): boolean {
    const target = tx
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    const agent = tx.select().from(agents).where(eq(agents.id, receipt.agentId)).get();
    return (
      target?.runtime === receipt.originRuntime &&
      target.agentPath === receipt.originAgentPath &&
      agent?.status === 'active' &&
      agent.runtime === receipt.originRuntime &&
      agent.projectPath === receipt.originAgentPath
    );
  }
  private moveQueue(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    fromId: string,
    toId: string
  ): void {
    const row = tx
      .select()
      .from(sessionMessageQueue)
      .where(eq(sessionMessageQueue.id, receipt.queueMessageId))
      .get();
    if (!row || row.sessionId !== fromId || row.clientId !== `system:${receipt.sourceKind}`)
      throw new DocChannelIdentityBlockedError();
    const rows = tx
      .select({ position: sessionMessageQueue.position })
      .from(sessionMessageQueue)
      .where(eq(sessionMessageQueue.sessionId, toId))
      .all();
    const position = Math.max(0, ...rows.map((entry) => entry.position)) + QUEUE_POSITION_STEP;
    tx.update(sessionMessageQueue)
      .set({ sessionId: toId, position })
      .where(eq(sessionMessageQueue.id, receipt.queueMessageId))
      .run();
  }
}

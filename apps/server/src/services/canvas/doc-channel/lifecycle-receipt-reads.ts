import { canvasDocIdentityIntents, inArray, and, type Db } from '@dorkos/db';
import type { CanvasChannelDeclaration } from '@dorkos/shared/canvas-channel-schemas';
import {
  eq,
  sessionMessageAcceptanceReceipts,
  sessionMetadata,
  agents,
  type DbTransaction,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';

/** Source-owned canonical receipt rebinding, inside the document move's transaction. */
export interface DocChannelReceiptRebinder {
  /** Suspend an exact authenticated source observation only after SQLite ownership rollback. */
  onRebindFailed?(error: unknown): undefined;
  /** Revalidate and rebind one accepted receipt without changing its source authority. */
  rebindAccepted(
    tx: DbTransaction,
    receiptId: string,
    fromId: string,
    toId: string,
    previousSourceScope?: string
  ): boolean;
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

/** Read the original accepted receipt without changing custody. */
export function readLifecycleReceipt(
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

/** Compare original receipt target data without changing custody. */
export function sameLifecycleReceiptTarget(
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

/** Read durable payload-free identity health without issuing admission authority. */
export function readLifecycleHealth(
  db: Db,
  documentId: string
): { status: 'ready' | 'in_doubt'; reasons: string[] } {
  const intents = db
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
        reasons: [...new Set(intents.map((intent) => intent.errorCode ?? 'identity_move_pending'))],
      }
    : { status: 'ready', reasons: [] };
}

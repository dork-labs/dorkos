/** Immutable connector execution intents and append-only terminal receipts. */
import { ulid } from 'ulidx';
import {
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  eq,
  isNull,
  type Db,
} from '@dorkos/db';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';

/** Publicly safe terminal vocabulary retained by the internal receipt ledger. */
export type ConnectorUsageOutcome =
  'success' | 'error' | 'cancelled' | 'outcome_unknown' | 'unsupported';

/** One immutable attempt written before provider dispatch. */
export interface ConnectorUsageIntentInput {
  /** Server-minted unique provider attempt. */
  readonly attemptId: string;
  /** Server-minted id shared only by safe retries of one call. */
  readonly logicalOperationId: string;
  /** One-based attempt order under the logical operation. */
  readonly attemptIndex: number;
  /** DorkOS surface that initiated the call. */
  readonly surface: 'mcp' | 'rest' | 'cli' | 'event';
  /** Verified actor category. */
  readonly actorKind: 'operator' | 'agent' | 'program' | 'event' | 'runtime';
  /** Stable verified actor identifier. */
  readonly actorId: string;
  /** Owner or local installation holding the connection authority. */
  readonly owner: ConnectorOwnerAuthority;
  /** Stable agent receiving the authority, when applicable. */
  readonly agentId?: string;
  /** Canonical session receiving the authority, when applicable. */
  readonly sessionId?: string;
  /** Exact stable DorkOS connection. */
  readonly connectionId: string;
  /** Exact configured provider instance. */
  readonly providerInstanceId: string;
  /** Provider implementation type retained for billing attribution. */
  readonly providerType: string;
  /** Who pays for the provider call. */
  readonly payer: 'operator_byo' | 'dorkos_managed';
  /** Exact immutable operation revision. */
  readonly operationRevisionId: string;
  /** ISO timestamp recorded immediately before provider entry. */
  readonly startedAt: string;
}

/** Terminal evidence that must match its immutable pre-dispatch intent. */
export interface ConnectorUsageTerminalInput {
  /** Intent being completed. */
  readonly attemptId: string;
  /** Expected logical operation from the current authorized dispatch. */
  readonly logicalOperationId: string;
  /** Expected authority owner from the current authorized dispatch. */
  readonly owner: ConnectorOwnerAuthority;
  /** Expected provider instance from the current authorized dispatch. */
  readonly providerInstanceId: string;
  /** Expected immutable operation revision from the current authorized dispatch. */
  readonly operationRevisionId: string;
  /** Normalized terminal result. */
  readonly outcome: ConnectorUsageOutcome;
  /** Provider support log identifier kept internal. */
  readonly providerLogId?: string;
  /** Safe normalized error code, never a raw error. */
  readonly errorCode?: string;
  /** Provider completion time when independently known. */
  readonly completedAt?: string;
  /** Local append time used for durable ledger ordering. */
  readonly recordedAt: string;
  /** Trusted source of this receipt. */
  readonly provenance: 'broker' | 'managed_provider' | 'startup_recovery';
}

/** Typed refusal for mismatched, duplicate, or missing usage evidence. */
export class ConnectorUsageEvidenceError extends Error {
  /** Stable internal code suitable for a typed server error boundary. */
  readonly code: 'intent_missing' | 'intent_mismatch' | 'receipt_conflict';

  /**
   * Construct a safe usage-evidence error.
   *
   * @param code - Stable refusal category.
   * @param message - Secret-free diagnostic.
   */
  constructor(code: ConnectorUsageEvidenceError['code'], message: string) {
    super(message);
    this.name = 'ConnectorUsageEvidenceError';
    this.code = code;
  }
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

/** Synchronous SQLite store for immutable execution evidence. */
export class ConnectorUsageStore {
  /**
   * Construct the usage store.
   *
   * @param db - Canonical DorkOS database.
   */
  constructor(private readonly db: Db) {}

  /** Persist an owner-bound intent before any provider work begins. */
  recordIntent(input: ConnectorUsageIntentInput): void {
    if (!Number.isInteger(input.attemptIndex) || input.attemptIndex < 1) {
      throw new ConnectorUsageEvidenceError(
        'intent_mismatch',
        'Execution attempt index must be a positive integer.'
      );
    }
    const owner = ownerColumns(input.owner);
    this.db
      .insert(connectorUsageAttempts)
      .values({
        attemptId: input.attemptId,
        logicalOperationId: input.logicalOperationId,
        attemptIndex: input.attemptIndex,
        surface: input.surface,
        actorKind: input.actorKind,
        actorId: input.actorId,
        ...owner,
        agentId: input.agentId,
        sessionId: input.sessionId,
        connectionId: input.connectionId,
        providerInstanceId: input.providerInstanceId,
        providerType: input.providerType,
        payer: input.payer,
        operationRevisionId: input.operationRevisionId,
        startedAt: input.startedAt,
      })
      .run();
  }

  /** Append one terminal receipt, deduping only an exactly equivalent repeat. */
  appendTerminal(input: ConnectorUsageTerminalInput): string {
    const expectedOwner = ownerColumns(input.owner);
    return this.db.transaction((tx) => {
      const intent = tx
        .select()
        .from(connectorUsageAttempts)
        .where(eq(connectorUsageAttempts.attemptId, input.attemptId))
        .get();
      if (!intent) {
        throw new ConnectorUsageEvidenceError('intent_missing', 'Execution intent was not found.');
      }
      if (
        intent.logicalOperationId !== input.logicalOperationId ||
        intent.ownerKind !== expectedOwner.ownerKind ||
        intent.ownerId !== expectedOwner.ownerId ||
        intent.providerInstanceId !== input.providerInstanceId ||
        intent.operationRevisionId !== input.operationRevisionId
      ) {
        throw new ConnectorUsageEvidenceError(
          'intent_mismatch',
          'Terminal receipt did not match the immutable execution intent.'
        );
      }
      const existing = tx
        .select()
        .from(connectorUsageTerminalReceipts)
        .where(eq(connectorUsageTerminalReceipts.attemptId, input.attemptId))
        .get();
      if (existing) {
        const equivalent =
          existing.outcome === input.outcome &&
          existing.providerLogId === (input.providerLogId ?? null) &&
          existing.errorCode === (input.errorCode ?? null) &&
          existing.completedAt === (input.completedAt ?? null) &&
          existing.recordedAt === input.recordedAt &&
          existing.provenance === input.provenance;
        if (!equivalent) {
          throw new ConnectorUsageEvidenceError(
            'receipt_conflict',
            'A different terminal receipt already exists for this attempt.'
          );
        }
        return existing.receiptId;
      }
      const receiptId = ulid();
      tx.insert(connectorUsageTerminalReceipts)
        .values({
          receiptId,
          attemptId: input.attemptId,
          outcome: input.outcome,
          providerLogId: input.providerLogId,
          errorCode: input.errorCode,
          completedAt: input.completedAt,
          recordedAt: input.recordedAt,
          provenance: input.provenance,
        })
        .run();
      return receiptId;
    });
  }

  /** Append unknown receipts for intents a previous process left nonterminal. */
  recoverPending(recordedAt: string): number {
    const rows = this.db
      .select({
        attemptId: connectorUsageAttempts.attemptId,
        logicalOperationId: connectorUsageAttempts.logicalOperationId,
        ownerKind: connectorUsageAttempts.ownerKind,
        ownerId: connectorUsageAttempts.ownerId,
        providerInstanceId: connectorUsageAttempts.providerInstanceId,
        operationRevisionId: connectorUsageAttempts.operationRevisionId,
      })
      .from(connectorUsageAttempts)
      .leftJoin(
        connectorUsageTerminalReceipts,
        eq(connectorUsageTerminalReceipts.attemptId, connectorUsageAttempts.attemptId)
      )
      .where(isNull(connectorUsageTerminalReceipts.attemptId))
      .all();
    let recovered = 0;
    for (const row of rows) {
      if (!row.ownerKind || !row.ownerId) continue;
      const owner: ConnectorOwnerAuthority =
        row.ownerKind === 'user'
          ? { kind: 'user', userId: row.ownerId }
          : { kind: 'local_install', installationId: row.ownerId };
      this.appendTerminal({
        attemptId: row.attemptId,
        logicalOperationId: row.logicalOperationId,
        owner,
        providerInstanceId: row.providerInstanceId,
        operationRevisionId: row.operationRevisionId,
        outcome: 'outcome_unknown',
        errorCode: 'SERVER_RESTARTED_AFTER_INTENT',
        recordedAt,
        provenance: 'startup_recovery',
      });
      recovered += 1;
    }
    return recovered;
  }
}

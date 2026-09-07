/** Immutable local mirror and recovery for hosted managed execution receipts. */
import {
  asc,
  and,
  connectorManagedReceiptRecoveries,
  connectorManagedUsageMirrors,
  connectorUsageAttempts,
  eq,
  isNull,
  lte,
  or,
  type Db,
} from '@dorkos/db';
import {
  ManagedConnectorExecutionReceiptSchema,
  type ManagedConnectorExecutionReceipt,
  type ManagedConnectorExecutionReceiptStatus,
} from '@dorkos/shared/connector-managed-schemas';

const RECEIPT_RECOVERY_MIN_DELAY_MS = 5_000;
const RECEIPT_RECOVERY_MAX_DELAY_MS = 5 * 60_000;

/** Hosted receipt lookup used only for idempotent recovery. */
export interface ManagedReceiptRecoveryCloudPort {
  /** Read one attempt's hosted accounting state without redispatching it. */
  getManagedConnectorExecutionReceipt(
    attemptId: string,
    signal: AbortSignal
  ): Promise<ManagedConnectorExecutionReceiptStatus>;
}

/** Typed refusal for missing, mismatched, or conflicting hosted evidence. */
export class ManagedUsageMirrorError extends Error {
  /** Construct one safe mirror refusal. */
  constructor(
    readonly code: 'intent_missing' | 'intent_mismatch' | 'receipt_conflict',
    message: string
  ) {
    super(message);
    this.name = 'ManagedUsageMirrorError';
  }
}

/** Construction dependencies for the hosted receipt mirror. */
export interface ManagedUsageMirrorServiceOptions {
  /** Canonical local connector database. */
  readonly db: Db;
  /** Idempotent hosted receipt reader. */
  readonly cloud: ManagedReceiptRecoveryCloudPort;
  /** Clock used only for local mirror insertion time. */
  readonly now?: () => Date;
  /** Safe recovery failure observer. */
  readonly onRecoveryError?: (attemptId: string, error: unknown) => void;
}

/** Persist hosted receipts separately from the broker's local continuity ledger. */
export class ManagedUsageMirrorService {
  private readonly db: Db;
  private readonly cloud: ManagedReceiptRecoveryCloudPort;
  private readonly now: () => Date;
  private readonly onRecoveryError: (attemptId: string, error: unknown) => void;
  private recovering = false;

  /** Construct the mirror over the local ledger and hosted receipt reader. */
  constructor(options: ManagedUsageMirrorServiceOptions) {
    this.db = options.db;
    this.cloud = options.cloud;
    this.now = options.now ?? (() => new Date());
    this.onRecoveryError = options.onRecoveryError ?? (() => {});
  }

  /**
   * Append one authoritative hosted receipt after matching its immutable local
   * intent. This never writes or replaces the broker terminal receipt.
   */
  observe(rawReceipt: ManagedConnectorExecutionReceipt): void {
    const receipt = ManagedConnectorExecutionReceiptSchema.parse(rawReceipt);
    this.db.transaction((tx) => {
      const intent = tx
        .select({
          logicalOperationId: connectorUsageAttempts.logicalOperationId,
          attemptIndex: connectorUsageAttempts.attemptIndex,
          payer: connectorUsageAttempts.payer,
        })
        .from(connectorUsageAttempts)
        .where(eq(connectorUsageAttempts.attemptId, receipt.attemptId))
        .get();
      if (!intent) {
        throw new ManagedUsageMirrorError(
          'intent_missing',
          'The hosted receipt has no immutable local execution intent.'
        );
      }
      if (
        intent.payer !== 'dorkos_managed' ||
        intent.logicalOperationId !== receipt.logicalOperationId ||
        intent.attemptIndex !== receipt.attemptIndex
      ) {
        throw new ManagedUsageMirrorError(
          'intent_mismatch',
          'The hosted receipt does not match its immutable managed execution intent.'
        );
      }
      const existingByAttempt = tx
        .select()
        .from(connectorManagedUsageMirrors)
        .where(eq(connectorManagedUsageMirrors.attemptId, receipt.attemptId))
        .get();
      const existingByReceipt = tx
        .select()
        .from(connectorManagedUsageMirrors)
        .where(eq(connectorManagedUsageMirrors.hostedReceiptId, receipt.receiptId))
        .get();
      const existing = existingByAttempt ?? existingByReceipt;
      if (existing) {
        const equivalent =
          existing.hostedReceiptId === receipt.receiptId &&
          existing.attemptId === receipt.attemptId &&
          existing.outcome === receipt.outcome &&
          existing.errorCode === (receipt.errorCode ?? null) &&
          existing.completedAt === receipt.completedAt &&
          existing.recordedAt === receipt.recordedAt;
        if (!equivalent) {
          throw new ManagedUsageMirrorError(
            'receipt_conflict',
            'Different hosted receipt evidence already exists for this attempt.'
          );
        }
        tx.delete(connectorManagedReceiptRecoveries)
          .where(eq(connectorManagedReceiptRecoveries.attemptId, receipt.attemptId))
          .run();
        return;
      }
      tx.insert(connectorManagedUsageMirrors)
        .values({
          hostedReceiptId: receipt.receiptId,
          attemptId: receipt.attemptId,
          outcome: receipt.outcome,
          errorCode: receipt.errorCode,
          completedAt: receipt.completedAt,
          recordedAt: receipt.recordedAt,
          mirroredAt: this.now().toISOString(),
        })
        .run();
      tx.delete(connectorManagedReceiptRecoveries)
        .where(eq(connectorManagedReceiptRecoveries.attemptId, receipt.attemptId))
        .run();
    });
  }

  /** Recover a bounded page of missing mirrors through receipt GETs only. */
  async recover(limit: number, signal: AbortSignal): Promise<number> {
    if (this.recovering || signal.aborted) return 0;
    this.recovering = true;
    try {
      const now = this.now();
      const attempts = this.db
        .select({
          attemptId: connectorUsageAttempts.attemptId,
          recoveryAttemptCount: connectorManagedReceiptRecoveries.attemptCount,
        })
        .from(connectorUsageAttempts)
        .leftJoin(
          connectorManagedUsageMirrors,
          eq(connectorManagedUsageMirrors.attemptId, connectorUsageAttempts.attemptId)
        )
        .leftJoin(
          connectorManagedReceiptRecoveries,
          eq(connectorManagedReceiptRecoveries.attemptId, connectorUsageAttempts.attemptId)
        )
        .where(
          and(
            eq(connectorUsageAttempts.payer, 'dorkos_managed'),
            isNull(connectorManagedUsageMirrors.attemptId),
            or(
              isNull(connectorManagedReceiptRecoveries.attemptId),
              lte(connectorManagedReceiptRecoveries.nextAttemptAt, now.toISOString())
            )
          )
        )
        .orderBy(asc(connectorUsageAttempts.startedAt), asc(connectorUsageAttempts.attemptId))
        .limit(Math.max(1, Math.min(limit, 100)))
        .all();
      let recovered = 0;
      for (const { attemptId, recoveryAttemptCount } of attempts) {
        if (signal.aborted) break;
        try {
          const status = await this.cloud.getManagedConnectorExecutionReceipt(attemptId, signal);
          if (status.state === 'recorded') {
            this.observe(status.receipt);
            recovered += 1;
          } else {
            this.scheduleRetry(attemptId, recoveryAttemptCount ?? 0);
          }
        } catch (error) {
          if (signal.aborted) break;
          this.scheduleRetry(attemptId, recoveryAttemptCount ?? 0);
          this.onRecoveryError(attemptId, error);
        }
      }
      return recovered;
    } finally {
      this.recovering = false;
    }
  }

  private scheduleRetry(attemptId: string, previousAttemptCount: number): void {
    const now = this.now();
    const attemptCount = previousAttemptCount + 1;
    const delay = Math.min(
      RECEIPT_RECOVERY_MIN_DELAY_MS * 2 ** Math.min(previousAttemptCount, 6),
      RECEIPT_RECOVERY_MAX_DELAY_MS
    );
    const nextAttemptAt = new Date(now.getTime() + delay).toISOString();
    this.db
      .insert(connectorManagedReceiptRecoveries)
      .values({
        attemptId,
        attemptCount,
        nextAttemptAt,
        updatedAt: now.toISOString(),
      })
      .onConflictDoUpdate({
        target: connectorManagedReceiptRecoveries.attemptId,
        set: { attemptCount, nextAttemptAt, updatedAt: now.toISOString() },
      })
      .run();
  }
}

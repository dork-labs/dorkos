/** Bounded accepted delivery recovery; notifications contain only committed receipt identities. */
import {
  and,
  asc,
  eq,
  gt,
  isNull,
  lte,
  or,
  sql,
  canvasDocBatches,
  sessionMessageAcceptanceReceipts,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';
import type { DocBatchPumpOptions } from './pump.js';
import type { DocWarningCursor } from './warnings.js';
/** A scheduler retry is not an authoritative budget hold and cannot postpone runtime dispatch. */
export const DOC_RESUME_RETRY_CODE = 'document_resume_retry';
const RESUME_RETRY_MS = 60000;
export interface DocRecoveryCursor {
  acceptedAt: string;
  id: string;
}
export interface DocRecoveryPage {
  notifications: Map<string, string[]>;
  selected: number;
  cursor?: DocRecoveryCursor;
  hasMore: boolean;
  nextEligibleAt: string | null;
  retryableFailures: number;
  integrityCursor?: DocRecoveryCursor;
  hasIntegrityMore: boolean;
  warningCursor?: DocWarningCursor;
  hasWarningMore?: boolean;
}
type Options = Pick<DocBatchPumpOptions, 'db' | 'store' | 'admission' | 'now'>;
const receipts = sessionMessageAcceptanceReceipts;
const batches = canvasDocBatches;
const accepted = and(
  eq(receipts.sourceKind, 'document_event_batch'),
  eq(receipts.state, 'accepted')
);
const exactBatch = and(
  eq(batches.batchId, receipts.sourceId),
  eq(batches.generation, receipts.sourceGeneration),
  eq(batches.admissionReceiptId, receipts.id),
  eq(batches.status, 'accepted')
);
/** A caller retains this immutable keyset across pages and clears it at exhaustion to wrap. */
export async function consumeAcceptedDocWakes(
  options: Options,
  cursor?: DocRecoveryCursor,
  limit = 100,
  integrityCursor?: DocRecoveryCursor
): Promise<DocRecoveryPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Document recovery limit must be between 1 and 100.');
  if (
    [cursor, integrityCursor].some(
      (key) =>
        key &&
        (!key.id ||
          !Number.isFinite(Date.parse(key.acceptedAt)) ||
          new Date(key.acceptedAt).toISOString() !== key.acceptedAt)
    )
  )
    throw new RangeError('Invalid document recovery cursor.');
  const now = options.now().toISOString();
  const rows = options.db
    .select({ receipt: receipts })
    .from(receipts)
    .innerJoin(batches, exactBatch)
    .where(
      and(
        accepted,
        or(isNull(batches.leaseUntil), lte(batches.leaseUntil, now)),
        cursor
          ? or(
              gt(receipts.acceptedAt, cursor.acceptedAt),
              and(eq(receipts.acceptedAt, cursor.acceptedAt), gt(receipts.id, cursor.id))
            )
          : undefined
      )
    )
    .orderBy(asc(receipts.acceptedAt), asc(receipts.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const result: DocRecoveryPage = {
    notifications: new Map(),
    selected: page.length,
    hasMore: rows.length > limit,
    nextEligibleAt: null,
    retryableFailures: 0,
    hasIntegrityMore: false,
    ...(page.length
      ? {
          cursor: {
            acceptedAt: page.at(-1)!.receipt.acceptedAt,
            id: page.at(-1)!.receipt.id,
          },
        }
      : {}),
  };
  for (const { receipt } of page) {
    try {
      await options.admission.acceptance.prepare(receipt.id);
      const sessionId = advanceWake(options, receipt);
      if (sessionId) {
        const ids = result.notifications.get(sessionId) ?? [];
        ids.push(receipt.id);
        result.notifications.set(sessionId, ids);
      }
    } catch (error) {
      try {
        if (options.admission.acceptance.isPreclaimRefusal(receipt.id, error)) {
          options.admission.acceptance.cancel(receipt.id, 'document_recovery_authority_refused');
          continue;
        }
        // This lease schedules another inspection; it supplies no final-claim eligibility.
        advanceWake(options, receipt);
      } catch {
        // A failed retry write retains original durable evidence and previous notifications.
      }
      result.retryableFailures++;
    }
  }
  // Integrity work has its own bounded keyset. Join damage alone grants no cancellation authority.
  try {
    const damaged = options.db
      .select({ receipt: receipts })
      .from(receipts)
      .leftJoin(batches, exactBatch)
      .where(
        and(
          accepted,
          isNull(batches.batchId),
          integrityCursor
            ? or(
                gt(receipts.acceptedAt, integrityCursor.acceptedAt),
                and(
                  eq(receipts.acceptedAt, integrityCursor.acceptedAt),
                  gt(receipts.id, integrityCursor.id)
                )
              )
            : undefined
        )
      )
      .orderBy(asc(receipts.acceptedAt), asc(receipts.id))
      .limit(limit + 1)
      .all();
    result.hasIntegrityMore = damaged.length > limit;
    for (const { receipt } of damaged.slice(0, limit)) {
      result.integrityCursor = { acceptedAt: receipt.acceptedAt, id: receipt.id };
      try {
        await options.admission.acceptance.prepare(receipt.id);
        result.retryableFailures++;
      } catch (error) {
        try {
          if (options.admission.acceptance.isPreclaimRefusal(receipt.id, error)) {
            options.admission.acceptance.cancel(receipt.id, 'document_recovery_authority_refused');
            continue;
          }
        } catch {
          /* Preserve uncertain integrity evidence for bounded retry. */
        }
        result.retryableFailures++;
      }
    }
    result.nextEligibleAt =
      options.db
        .select({
          at: sql<
            string | null
          >`min(coalesce(${batches.leaseUntil}, ${options.now().toISOString()}))`,
        })
        .from(receipts)
        .innerJoin(batches, exactBatch)
        .where(accepted)
        .get()?.at ?? null;
  } catch {
    result.retryableFailures++;
  }
  if (result.retryableFailures) {
    const retry = new Date(Date.parse(options.now().toISOString()) + RESUME_RETRY_MS).toISOString();
    // A failed lease write requires a bounded host retry rather than spinning on a past wake.
    if (!result.nextEligibleAt || result.nextEligibleAt <= now) result.nextEligibleAt = retry;
    else if (retry < result.nextEligibleAt) result.nextEligibleAt = retry;
  }
  if (result.hasMore || result.hasIntegrityMore) result.nextEligibleAt = now;
  return result;
}
/** Recheck after every await and CAS only the same accepted generation in its current canonical session. */
function advanceWake(
  options: Options,
  original: SessionMessageAcceptanceReceipt
): string | undefined {
  return options.store.transaction((tx) => {
    const current = tx.select().from(receipts).where(eq(receipts.id, original.id)).get();
    if (
      !current ||
      current.state !== 'accepted' ||
      current.sourceKind !== original.sourceKind ||
      current.sourceId !== original.sourceId ||
      current.sourceGeneration !== original.sourceGeneration
    )
      return undefined;
    const batch = options.store.getBatch(current.sourceId, tx);
    if (!batch || batch.scope !== `session:${current.sessionId}`) return undefined;
    const now = options.now().toISOString();
    const changed = tx
      .update(batches)
      .set({
        leaseUntil: new Date(Date.parse(now) + RESUME_RETRY_MS).toISOString(),
        errorCode: DOC_RESUME_RETRY_CODE,
        updatedAt: now,
      })
      .where(
        and(
          eq(batches.batchId, current.sourceId),
          eq(batches.generation, current.sourceGeneration),
          eq(batches.admissionReceiptId, current.id),
          eq(batches.status, 'accepted'),
          or(isNull(batches.leaseUntil), lte(batches.leaseUntil, now))
        )
      )
      .run().changes;
    return changed === 1 ? current.sessionId : undefined;
  });
}

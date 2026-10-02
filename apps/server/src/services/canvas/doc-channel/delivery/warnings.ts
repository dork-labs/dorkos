/** Accepted wait warnings inspect durable evidence without acquiring dispatch authority. */
import {
  and,
  asc,
  eq,
  gt,
  isNull,
  or,
  sql,
  canvasDocBatches as batches,
  canvasDocGrants as grants,
  sessionMessageAcceptanceReceipts as receipts,
} from '@dorkos/db';
import { CanvasChannelRouteSchema } from '@dorkos/shared/canvas-channel-schemas';
import type { DocBatchPumpOptions } from './pump.js';
import { readDocBatchAuthority, verifyDocReceipt } from './batch-authority.js';
import { appendDocStatus } from '../status.js';

export const DOC_WAIT_WARNING =
  'This document update is still waiting. You can review it before it runs.';
const WARNING_MS = 15 * 60_000;
const RETRY_MS = 60_000;
export interface DocWarningCursor {
  dueAt: string;
  batchId: string;
}
export interface DocWarningPage {
  warned: number;
  selected: number;
  cursor?: DocWarningCursor;
  hasMore: boolean;
  nextEligibleAt: string | null;
  retryableFailures: number;
}
const exact = and(
  eq(batches.batchId, receipts.sourceId),
  eq(batches.generation, receipts.sourceGeneration),
  eq(batches.admissionReceiptId, receipts.id)
);
// Acceptance projects routed before adoption; a busy dispatcher can leave that
// exact unclaimed receipt waiting without a budget-defer status transition.
const waiting = and(
  eq(batches.status, 'accepted'),
  isNull(batches.waitingWarningAt),
  eq(receipts.sourceKind, 'document_event_batch'),
  eq(receipts.state, 'accepted'),
  isNull(receipts.dispatchClaimedAt),
  isNull(receipts.turnStartedAt),
  sql`${batches.scope} = 'session:' || ${receipts.sessionId}`,
  sql`exists (select 1 from canvas_doc_deliveries d where d.document_id = ${batches.documentId} and d.batch_id = ${batches.batchId}
    and d.route_id = ${batches.routeId}
    and d.status in ('waiting','routed') and d.event_id in (select value from json_each(${batches.inputEventIds})))`
);

/** One keyset page, independent of the receipt's final dispatch deadline. */
export async function inspectAcceptedDocWaitWarnings(
  options: DocBatchPumpOptions,
  cursor?: DocWarningCursor,
  limit = 100,
  shouldContinue: () => boolean = () => true
): Promise<DocWarningPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Invalid document warning limit.');
  if (
    cursor &&
    (!cursor.batchId ||
      !Number.isFinite(Date.parse(cursor.dueAt)) ||
      new Date(cursor.dueAt).toISOString() !== cursor.dueAt)
  )
    throw new RangeError('Invalid document warning cursor.');
  const rows = options.db
    .select({ receipt: receipts, batch: batches, route: grants.normalizedRoute })
    .from(batches)
    .innerJoin(receipts, exact)
    .innerJoin(
      grants,
      and(eq(grants.documentId, batches.documentId), eq(grants.grantId, batches.grantId))
    )
    .where(
      and(
        waiting,
        cursor
          ? or(
              gt(batches.dueAt, cursor.dueAt),
              and(eq(batches.dueAt, cursor.dueAt), gt(batches.batchId, cursor.batchId))
            )
          : undefined
      )
    )
    .orderBy(asc(batches.dueAt), asc(batches.batchId))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const result: DocWarningPage = {
    warned: 0,
    selected: page.length,
    hasMore: rows.length > limit,
    nextEligibleAt: null,
    retryableFailures: 0,
    ...(page.length
      ? { cursor: { dueAt: page.at(-1)!.batch.dueAt, batchId: page.at(-1)!.batch.batchId } }
      : {}),
  };
  for (const row of page) {
    if (!shouldContinue()) break;
    try {
      const route = CanvasChannelRouteSchema.parse(row.route);
      const deadline =
        Date.parse(row.batch.dueAt) +
        WARNING_MS -
        (route.turn.mode === 'coalesce' ? route.turn.windowMs : 0);
      if (!Number.isFinite(deadline)) throw new Error('Invalid document warning deadline.');
      if (deadline > options.now().getTime()) continue;
      await options.admission.acceptance.prepare(row.receipt.id);
      if (!shouldContinue()) break;
      const observation = options.store.transaction((tx) => {
        const current = tx.select().from(receipts).where(eq(receipts.id, row.receipt.id)).get();
        const batch = options.store.getBatch(row.batch.batchId, tx);
        if (
          !current ||
          !batch ||
          current.state !== 'accepted' ||
          batch.status !== 'accepted' ||
          current.dispatchClaimedAt !== null ||
          current.turnStartedAt !== null ||
          current.sourceKind !== 'document_event_batch' ||
          current.sourceId !== row.batch.batchId ||
          current.sourceGeneration !== row.batch.generation ||
          batch.generation !== row.batch.generation ||
          batch.admissionReceiptId !== current.id ||
          batch.waitingWarningAt !== null
        )
          return undefined;
        const authority = readDocBatchAuthority(options.store, options.grants, tx, batch);
        verifyDocReceipt(authority, current);
        const currentRoute = CanvasChannelRouteSchema.parse(authority.grant.normalizedRoute);
        const due =
          Date.parse(batch.dueAt) +
          WARNING_MS -
          (currentRoute.turn.mode === 'coalesce' ? currentRoute.turn.windowMs : 0);
        const now = options.now().toISOString();
        if (
          !Number.isFinite(due) ||
          due > Date.parse(now) ||
          !options.store.markAcceptedWaitingWarning(current.id, batch.generation, now, tx)
        )
          return undefined;
        appendDocStatus(
          options.store,
          tx,
          batch.documentId,
          {
            batchId: batch.batchId,
            routeId: batch.routeId,
            status: 'waiting',
            warning: DOC_WAIT_WARNING,
            receiptId: current.id,
            messageId: current.queueMessageId,
            ...(batch.leaseUntil ? { nextEligibleAt: batch.leaseUntil } : {}),
          },
          now
        );
        return {
          batchId: batch.batchId,
          documentId: batch.documentId,
          routeId: batch.routeId,
          outcome: 'warning' as const,
        };
      });
      if (observation) {
        result.warned++;
        try {
          options.observe?.(observation);
        } catch {
          /* Committed warnings survive diagnostic failure. */
        }
      }
    } catch {
      result.retryableFailures++;
    }
  }
  // SQL computes the same immutable coalescing anchor across every remaining page.
  try {
    const minimum = options.db
      .select({
        at: sql<number | null>`min(
    (julianday(${batches.dueAt}) - 2440587.5) * 86400000 + ${WARNING_MS} -
    case when json_extract(${grants.normalizedRoute}, '$.turn.mode') = 'coalesce'
      then json_extract(${grants.normalizedRoute}, '$.turn.windowMs') else 0 end)`,
      })
      .from(batches)
      .innerJoin(receipts, exact)
      .innerJoin(
        grants,
        and(eq(grants.documentId, batches.documentId), eq(grants.grantId, batches.grantId))
      )
      .where(waiting)
      .get()?.at;
    if (minimum !== null && minimum !== undefined) {
      if (!Number.isFinite(minimum)) throw new Error('Invalid document warning deadline.');
      result.nextEligibleAt = new Date(Math.round(minimum)).toISOString();
    }
  } catch {
    // A failed minimum read cannot erase committed warnings or starve other recovery work.
    result.retryableFailures++;
  }
  if (
    result.retryableFailures &&
    (!result.nextEligibleAt || result.nextEligibleAt <= options.now().toISOString())
  )
    result.nextEligibleAt = new Date(options.now().getTime() + RETRY_MS).toISOString();
  return result;
}

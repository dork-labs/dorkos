/**
 * A person's review of document work that expired or ended in doubt.
 *
 * Nothing here runs on its own: the pump only marks work `expired` (unadmitted
 * after 24 hours) and boot recovery only marks it `in_doubt` (claimed or started
 * before a restart, outcome unknown). A person then either replays it, which
 * queues the same inputs as a NEW batch and generation under the route's current
 * grant, or clears it. Replaying in-doubt work needs `confirmRepeat`, because
 * the agent may already have acted on it. Either way the reviewed batch leaves
 * the review list once, inside one SQLite transaction, so a second submit is
 * refused rather than replayed twice.
 *
 * @module services/canvas/doc-channel/delivery/replay
 */
import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  inArray,
  isNull,
  canvasDocBatches,
  canvasDocDeliveries,
  type DbTransaction,
} from '@dorkos/db';
import {
  CanvasChannelRouteSchema,
  matchesCanvasChannelEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelNotFoundError } from '../authorization.js';
import { isServerPrincipal } from '../../../connectors/principal/server-principal.js';
import type { DocGrantActor } from '../grant-policy.js';
import type { DocChannelGrants } from '../grants.js';
import type { DocBatchRow, DocChannelStore } from '../store.js';
import { appendDocStatus } from '../status.js';

/**
 * The `error_code` values review reads and writes on `canvas_doc_batches`.
 * `doc-channel-metrics.ts` counts these exact literals.
 */
export const DOC_WORK_CODES = Object.freeze({
  /** Written by the pump when unadmitted work passes 24 hours. */
  expiredAwaitingReview: 'manual_replay_required',
  expiredReplayed: 'manual_replay_consumed',
  expiredCleared: 'manual_review_cleared',
  inDoubtReplayed: 'in_doubt_replayed',
  inDoubtCleared: 'in_doubt_cleared',
});

/** Why a review was refused. Each code is a fixed word, never caller data. */
export type DocWorkRefusalCode =
  | 'WORK_NOT_FOUND'
  | 'WORK_NOT_REVIEWABLE'
  | 'WORK_ALREADY_REVIEWED'
  | 'CONFIRM_REPEAT_REQUIRED'
  | 'ROUTE_CHANGED'
  | 'INPUTS_GONE'
  | 'ROUTE_BUSY';

/** A typed refusal the HTTP layer maps to one honest sentence. */
export class DocWorkReviewError extends Error {
  constructor(
    readonly code: DocWorkRefusalCode,
    readonly status: number
  ) {
    super(code);
    this.name = 'DocWorkReviewError';
  }
}

/** Where a batch stands for review. */
export type DocWorkReviewState = 'expired' | 'in_doubt' | 'reviewed' | 'other';

/** Read a batch's review state from its own row. */
export function docWorkReviewState(
  batch: Pick<DocBatchRow, 'status' | 'errorCode' | 'admissionReceiptId'>
): DocWorkReviewState {
  if (batch.status === 'in_doubt') return 'in_doubt';
  if (batch.status === 'expired') {
    if (batch.errorCode === DOC_WORK_CODES.expiredAwaitingReview && !batch.admissionReceiptId)
      return 'expired';
    if (
      batch.errorCode === DOC_WORK_CODES.expiredReplayed ||
      batch.errorCode === DOC_WORK_CODES.expiredCleared
    )
      return 'reviewed';
    return 'other';
  }
  if (
    batch.status === 'cancelled' &&
    (batch.errorCode === DOC_WORK_CODES.inDoubtReplayed ||
      batch.errorCode === DOC_WORK_CODES.inDoubtCleared)
  )
    return 'reviewed';
  return 'other';
}

/** What a person asks of one piece of work. */
interface DocWorkTarget {
  documentId: string;
  batchId: string;
  actor: DocGrantActor;
  now: string;
}

/** A replay: the target plus the route's current grant, read fresh by the caller. */
export interface DocReplayInput extends DocWorkTarget {
  grantId: string;
  /** In-doubt work may already have run; only a person's explicit yes repeats it. */
  confirmRepeat?: boolean;
}

/** One reviewed piece of work. */
export interface DocWorkReviewed {
  batchId: string;
  routeId: string;
  previousStatus: 'expired' | 'in_doubt';
  /** The new batch a replay queued; null for a clear. */
  nextBatchId: string | null;
}

function refuse(code: DocWorkRefusalCode, status = 409): never {
  throw new DocWorkReviewError(code, status);
}

/** The batch, on this document, in a state a person may review. */
function reviewable(
  store: DocChannelStore,
  tx: DbTransaction,
  documentId: string,
  batchId: string
): DocBatchRow & { status: 'expired' | 'in_doubt' } {
  const batch = store.getBatch(batchId, tx);
  // Another document's batch is as absent as no batch at all.
  if (!batch || batch.documentId !== documentId) refuse('WORK_NOT_FOUND', 404);
  const state = docWorkReviewState(batch);
  if (state === 'reviewed') refuse('WORK_ALREADY_REVIEWED');
  if (state === 'other') refuse('WORK_NOT_REVIEWABLE');
  return batch as DocBatchRow & { status: 'expired' | 'in_doubt' };
}

/** Move the reviewed batch out of review, once: the CAS is the double-submit guard. */
function settleReviewed(
  tx: DbTransaction,
  batch: DocBatchRow,
  action: 'replayed' | 'cleared',
  now: string
): void {
  const inDoubt = batch.status === 'in_doubt';
  const errorCode = inDoubt
    ? action === 'replayed'
      ? DOC_WORK_CODES.inDoubtReplayed
      : DOC_WORK_CODES.inDoubtCleared
    : action === 'replayed'
      ? DOC_WORK_CODES.expiredReplayed
      : DOC_WORK_CODES.expiredCleared;
  // In-doubt work holds its route's active slot; settling it frees the route.
  const moved = tx
    .update(canvasDocBatches)
    .set({ status: inDoubt ? 'cancelled' : 'expired', errorCode, leaseUntil: null, updatedAt: now })
    .where(
      and(
        eq(canvasDocBatches.batchId, batch.batchId),
        eq(canvasDocBatches.generation, batch.generation),
        eq(canvasDocBatches.status, batch.status),
        batch.errorCode === null
          ? isNull(canvasDocBatches.errorCode)
          : eq(canvasDocBatches.errorCode, batch.errorCode)
      )
    )
    .run().changes;
  if (moved !== 1) refuse('WORK_ALREADY_REVIEWED');
}

/**
 * Queue reviewed work again as a new batch and generation.
 *
 * Needs current authenticated ownership and the route's current grant, both
 * re-checked here inside the transaction. Every original input must still be
 * kept and still match the route and grant. The original event ids are reused;
 * nothing about the old attempt is reopened.
 *
 * @param store - The channel store.
 * @param grants - The grant service, for fresh authority.
 * @param input - The work, the current grant, and the person's confirmation.
 * @returns What was reviewed, with the new batch id.
 */
export function replayDocBatch(
  store: DocChannelStore,
  grants: DocChannelGrants,
  input: DocReplayInput
): DocWorkReviewed {
  const { documentId, batchId, grantId, actor, now } = input;
  if (!isServerPrincipal(actor.principal)) throw new DocChannelNotFoundError();
  grants.refreshAuthority(documentId, actor);
  return store.transaction((tx) => {
    const old = reviewable(store, tx, documentId, batchId);
    if (old.status === 'in_doubt' && input.confirmRepeat !== true)
      refuse('CONFIRM_REPEAT_REQUIRED');
    const grant = grants.revalidateGrant(documentId, grantId, actor, tx);
    const route = CanvasChannelRouteSchema.safeParse(grant.normalizedRoute);
    if (!route.success || grant.routeId !== old.routeId || route.data.turn.mode === 'none')
      refuse('ROUTE_CHANGED');
    for (const eventId of old.inputEventIds) {
      const event = store.getEvent(documentId, eventId, tx);
      if (
        !event ||
        event.payloadPrunedAt ||
        !matchesCanvasChannelEvent(route.data.on, event.type) ||
        !(grant.allowedTypes as string[]).some((pattern) =>
          matchesCanvasChannelEvent(pattern, event.type)
        )
      )
        refuse('INPUTS_GONE');
    }
    // One pending batch per route: newer work already holds the slot.
    const busy = tx
      .select({ batchId: canvasDocBatches.batchId })
      .from(canvasDocBatches)
      .where(
        and(
          eq(canvasDocBatches.documentId, documentId),
          eq(canvasDocBatches.routeId, old.routeId),
          inArray(canvasDocBatches.status, ['pending', 'waiting'])
        )
      )
      .get();
    if (busy) refuse('ROUTE_BUSY');
    settleReviewed(tx, old, 'replayed', now);
    const nextId = randomUUID();
    store.insertBatch(
      {
        batchId: nextId,
        documentId,
        scope: store.getChannel(documentId, tx)!.scope,
        routeId: old.routeId,
        grantId: grant.grantId,
        grantRevision: grant.revision,
        generation: randomUUID(),
        inputEventIds: [...old.inputEventIds],
        effectivePayload: { eventIds: [...old.inputEventIds] },
        dueAt: now,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
      tx
    );
    tx.update(canvasDocDeliveries)
      .set({ batchId: nextId, status: 'pending', reason: null, turnId: null, updatedAt: now })
      .where(
        and(
          eq(canvasDocDeliveries.batchId, old.batchId),
          inArray(canvasDocDeliveries.eventId, old.inputEventIds)
        )
      )
      .run();
    appendDocStatus(
      store,
      tx,
      documentId,
      {
        batchId: nextId,
        previousBatchId: old.batchId,
        previousStatus: old.status,
        routeId: old.routeId,
        status: 'pending',
        reason: 'explicit_replay',
      },
      now
    );
    return {
      batchId: old.batchId,
      routeId: old.routeId,
      previousStatus: old.status,
      nextBatchId: nextId,
    };
  });
}

/**
 * Set reviewed work aside without running it. Needs no grant: clearing starts
 * nothing. In-doubt deliveries become `cancelled` with reason `in_doubt_cleared`,
 * so they stop holding the document's backlog; the shared receipt keeps its
 * `outcome_unknown`, the record of what nobody knows.
 *
 * @param store - The channel store.
 * @param target - The work and who is clearing it.
 * @returns What was reviewed.
 */
export function clearDocBatch(store: DocChannelStore, target: DocWorkTarget): DocWorkReviewed {
  const { documentId, batchId, actor, now } = target;
  if (!isServerPrincipal(actor.principal)) throw new DocChannelNotFoundError();
  return store.transaction((tx) => {
    const old = reviewable(store, tx, documentId, batchId);
    settleReviewed(tx, old, 'cleared', now);
    if (old.status === 'in_doubt')
      tx.update(canvasDocDeliveries)
        .set({ status: 'cancelled', reason: DOC_WORK_CODES.inDoubtCleared, updatedAt: now })
        .where(
          and(
            eq(canvasDocDeliveries.batchId, old.batchId),
            eq(canvasDocDeliveries.status, 'in_doubt'),
            inArray(canvasDocDeliveries.eventId, old.inputEventIds)
          )
        )
        .run();
    appendDocStatus(
      store,
      tx,
      documentId,
      {
        batchId: old.batchId,
        routeId: old.routeId,
        status: old.status === 'in_doubt' ? 'cancelled' : 'expired',
        previousStatus: old.status,
        reason: 'review_cleared',
      },
      now
    );
    return {
      batchId: old.batchId,
      routeId: old.routeId,
      previousStatus: old.status,
      nextBatchId: null,
    };
  });
}

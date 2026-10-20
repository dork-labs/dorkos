/**
 * A person's review of one document's unfinished work (spec `doc-channel` task 2.5).
 *
 * Lists work that expired (never admitted within 24 hours) or ended in doubt
 * (it reached the agent, but its result is unknown), and lets a person
 * replay or clear one piece. Nothing here runs by itself and nothing repeats
 * on a timer: the pump and boot recovery only mark work, and only these writes
 * move it. Like the route controls beside it, every write needs the operator
 * principal and a {@link DocRoutePersonDecision}, which only the person bars
 * mint, so an agent cannot replay its own work through these routes.
 *
 * @module services/canvas/doc-channel/route-controls/work-review
 */
import { and, asc, eq, inArray, or, canvasDocBatches, type Db } from '@dorkos/db';
import { CanvasChannelDeclarationSchema } from '@dorkos/shared/canvas-channel-schemas';
import {
  CanvasDocWorkClearRequestSchema,
  CanvasDocWorkReplayRequestSchema,
  type CanvasDocWork,
  type CanvasDocWorkChange,
  type CanvasDocWorkReplay,
} from '@dorkos/shared/canvas-doc-routes';
import type { DocChannelAuthorization } from '../authorization.js';
import type { DocChannelGrants } from '../grants.js';
import { DocRouteGrantError, type DocGrantActor } from '../grant-policy.js';
import type { DocBatchRow, DocChannelRow, DocChannelStore } from '../store.js';
import {
  DOC_WORK_CODES,
  DocWorkReviewError,
  clearDocBatch,
  docWorkReviewState,
  docWorkRouteUnchanged,
  docWorkStillRunning,
  replayDocBatch,
  type DocWorkReviewed,
} from '../delivery/replay.js';
import { currentRouteGrants } from './current-grants.js';
import {
  requireOperatorActor,
  requirePersonDecision,
  type DocRoutePersonDecision,
} from './person-decision.js';

/** The most items one list returns; older work beyond it shows once these are reviewed. */
const LIST_LIMIT = 50;

/** What the review is composed from: the channel's own services, never copies. */
export interface DocWorkReviewDeps {
  db: Db;
  channels: DocChannelStore;
  grants: DocChannelGrants;
  authorization: Pick<DocChannelAuthorization, 'require' | 'requireCurrent'>;
  /** The authorized live channel row; refuses a closed or unreachable document. */
  readChannel(documentId: string, actor: DocGrantActor): Promise<DocChannelRow>;
  /** Called after a replay or clear commits, so delivery looks at the route again. */
  onChanged?: () => void;
  now?: () => Date;
}

/** Read, replay and clear one document's unfinished work. */
export class DocWorkReview {
  /** Compose over the channel's existing store, grant and authorization services. */
  constructor(private readonly deps: DocWorkReviewDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /**
   * Work waiting on a person, oldest first, each with whether it can run again now.
   *
   * @param documentId - The document, by id.
   * @param actor - The verified operator.
   */
  async list(documentId: string, actor: DocGrantActor): Promise<CanvasDocWork> {
    requireOperatorActor(actor);
    const channel = await this.deps.readChannel(documentId, actor);
    const rows = this.deps.db
      .select()
      .from(canvasDocBatches)
      .where(
        and(
          eq(canvasDocBatches.documentId, channel.documentId),
          or(
            eq(canvasDocBatches.status, 'in_doubt'),
            and(
              eq(canvasDocBatches.status, 'expired'),
              eq(canvasDocBatches.errorCode, DOC_WORK_CODES.expiredAwaitingReview)
            )
          )
        )
      )
      .orderBy(asc(canvasDocBatches.updatedAt), asc(canvasDocBatches.batchId))
      .limit(LIST_LIMIT)
      .all()
      .filter((row) => {
        const state = docWorkReviewState(row);
        return state === 'expired' || state === 'in_doubt';
      });
    if (!rows.length) return { documentId: channel.documentId, items: [] };
    const declaration = CanvasChannelDeclarationSchema.safeParse(channel.declaration);
    const routes = new Map(
      (declaration.success ? declaration.data.routes : []).map((route) => [route.id, route])
    );
    const current = currentRouteGrants(this.deps.grants, channel.documentId, actor);
    const busy = new Set(
      this.deps.db
        .select({ routeId: canvasDocBatches.routeId })
        .from(canvasDocBatches)
        .where(
          and(
            eq(canvasDocBatches.documentId, channel.documentId),
            inArray(canvasDocBatches.status, ['pending', 'waiting'])
          )
        )
        .all()
        .map((row) => row.routeId)
    );
    const replay = (row: DocBatchRow): CanvasDocWorkReplay => {
      if (row.status === 'in_doubt' && docWorkStillRunning(this.deps.db, row))
        return 'still_running';
      const route = routes.get(row.routeId);
      if (!route || route.turn.mode === 'none') return 'route_changed';
      const grantId = current.get(row.routeId);
      const grant = grantId ? this.deps.channels.getGrant(grantId) : undefined;
      if (!grant) return 'no_grant';
      if (!docWorkRouteUnchanged(this.deps.channels, row, grant.routeHash)) return 'route_changed';
      const kept = row.inputEventIds.every((id) => {
        const event = this.deps.channels.getEvent(channel.documentId, id);
        return !!event && !event.payloadPrunedAt;
      });
      if (!kept) return 'inputs_gone';
      return busy.has(row.routeId) ? 'route_busy' : 'ready';
    };
    return {
      documentId: channel.documentId,
      items: rows.map((row) => ({
        batchId: row.batchId,
        routeId: row.routeId,
        status: row.status as 'expired' | 'in_doubt',
        eventCount: row.inputEventIds.length,
        since: row.updatedAt,
        replay: replay(row),
      })),
    };
  }

  /** Current ownership of a live document, read fresh before any write. */
  private async requireOwner(documentId: string, actor: DocGrantActor): Promise<void> {
    await this.deps.authorization.require(documentId, actor, true);
  }

  /**
   * Run one piece of work again as new work, under the route's current grant.
   *
   * @param documentId - The document, by id.
   * @param batchId - The expired or in-doubt work.
   * @param body - `{ confirmRepeat: true }` for in-doubt work.
   * @param actor - The verified operator.
   * @param decision - The person bars' proof, from `decideAsPerson`.
   */
  async replay(
    documentId: string,
    batchId: string,
    body: unknown,
    actor: DocGrantActor,
    decision: DocRoutePersonDecision
  ): Promise<CanvasDocWorkChange> {
    requireOperatorActor(actor);
    requirePersonDecision(decision);
    const { confirmRepeat } = CanvasDocWorkReplayRequestSchema.parse(body);
    await this.requireOwner(documentId, actor);
    const batch = this.deps.channels.getBatch(batchId);
    if (!batch || batch.documentId !== documentId)
      throw new DocWorkReviewError('WORK_NOT_FOUND', 404);
    // The grant is read fresh here and revalidated again inside the replay's transaction.
    const grantId = currentRouteGrants(this.deps.grants, documentId, actor).get(batch.routeId);
    if (!grantId) throw new DocRouteGrantError('GRANT_REQUIRED', 409);
    const reviewed = replayDocBatch(this.deps.channels, this.deps.grants, {
      documentId,
      batchId,
      grantId,
      actor,
      now: this.now(),
      ...(confirmRepeat ? { confirmRepeat } : {}),
    });
    return this.changed(reviewed, 'replayed');
  }

  /**
   * Set one piece of work aside without running it.
   *
   * @param documentId - The document, by id.
   * @param batchId - The expired or in-doubt work.
   * @param body - Empty; the work is the whole subject.
   * @param actor - The verified operator.
   * @param decision - The person bars' proof, from `decideAsPerson`.
   */
  async clear(
    documentId: string,
    batchId: string,
    body: unknown,
    actor: DocGrantActor,
    decision: DocRoutePersonDecision
  ): Promise<CanvasDocWorkChange> {
    requireOperatorActor(actor);
    requirePersonDecision(decision);
    CanvasDocWorkClearRequestSchema.parse(body);
    await this.requireOwner(documentId, actor);
    const reviewed = clearDocBatch(this.deps.channels, this.deps.authorization, {
      documentId,
      batchId,
      actor,
      now: this.now(),
    });
    return this.changed(reviewed, 'cleared');
  }

  private changed(reviewed: DocWorkReviewed, action: 'replayed' | 'cleared'): CanvasDocWorkChange {
    try {
      this.deps.onChanged?.();
    } catch {
      /* The change is committed; delivery finds it on its next pass. */
    }
    return { ...reviewed, action };
  }
}

/**
 * A person's review of a canvas document's unfinished work, under `/api/canvas/docs`.
 *
 * - `GET  /:id/work` — work that expired or ended in doubt, waiting on a person
 * - `POST /:id/work/:batchId/replay` — run it again as new work (`confirmRepeat` for in-doubt)
 * - `POST /:id/work/:batchId/clear` — set it aside without running it
 *
 * The same bars as the route controls beside it (`canvas-doc-route-controls.ts`):
 * the operator principal for every route, and for the writes the person bars an
 * approval decision needs, minted by `decideAsPerson`. An agent cannot replay its
 * own work here. Each write records one `doc_work.reviewed` Activity line, in
 * the `permissions` category beside the route controls' own lines: it is a
 * person's decision about what an agent is asked to do, and that history is
 * kept past the retention prune.
 *
 * Wi-Fi keeps both writes: a replay is one run under a route that is already
 * allowed (by a person, or the opener's own route), clearing only narrows, and
 * allowing a route stays refused there.
 *
 * @module routes/canvas-doc-work-review
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  DOC_WORK_REVIEWED_EVENT,
  type CanvasDocWorkChange,
  type DocWorkReviewedMetadata,
} from '@dorkos/shared/canvas-doc-routes';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts } from '../http/request-facts.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import {
  decideAsPerson,
  type DocRoutePersonDecision,
} from '../services/canvas/doc-channel/route-controls/person-decision.js';
import { logger } from '../lib/logger.js';
import { writerFor } from './canvas-doc-route-controls.js';
import type { DocChannelHttpSource } from './canvas-doc-events.js';

const IdSchema = z.string().min(1).max(200);

/** One honest sentence per refusal code; a code not listed falls back by status. */
const CODE_MESSAGES: Record<string, string> = {
  INVALID_DOC_WORK_REQUEST: 'The request is not valid.',
  PERSON_REQUIRED: 'Only a person in DorkOS can run or clear document work.',
  WORK_NOT_FOUND: 'That work is not on this document.',
  WORK_NOT_REVIEWABLE: 'That work is not waiting on review.',
  WORK_ALREADY_REVIEWED: 'That work was already run again or cleared.',
  WORK_STILL_RUNNING: 'This work may still be running. Try again once it stops.',
  CONFIRM_REPEAT_REQUIRED: 'This may already have run. Confirm before running it again.',
  GRANT_REQUIRED: 'This route is off. Allow it before running the work again.',
  ROUTE_CHANGED: 'The route changed. It no longer takes this work.',
  INPUTS_GONE: 'Some of this work’s events are no longer kept.',
  ROUTE_BUSY: 'Newer work is waiting on this route, so this can’t run again now.',
  GRANT_REVOKED: 'This route is off. Allow it before running the work again.',
  GRANT_EXPIRED: 'This route’s approval ended. Allow it again first.',
  MANIFEST_CHANGED: 'The document’s app changed. Allow the route again first.',
  CANVAS_DOCUMENT_NOT_FOUND: 'The document is not available.',
  DOC_CHANNEL_UNAVAILABLE: 'Document work is not available yet.',
};
const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request is not valid.',
  401: 'Sign in to review document work.',
  403: 'This work cannot be changed right now.',
  404: 'The document or work is not available.',
  409: 'The work changed. Refresh and try again.',
  503: 'Document work is not available yet.',
};

/** Translate a refusal without echoing payloads, paths or authority evidence. */
function failure(c: Context<ApiEnv>, error: unknown): Response {
  const refusal = error as { code?: unknown; status?: unknown };
  let status =
    typeof refusal?.status === 'number' && refusal.status >= 400 && refusal.status <= 599
      ? refusal.status
      : 500;
  let code = typeof refusal?.code === 'string' ? refusal.code : 'DOC_WORK_FAILED';
  if (error instanceof z.ZodError) {
    status = 400;
    code = 'INVALID_DOC_WORK_REQUEST';
  } else if (refusal?.code === 'AGENT_IDENTITY_UNVERIFIED') status = 401;
  if (status === 500) logger.error('[canvas-doc-work-review] request failed', error);
  const message =
    CODE_MESSAGES[code] ?? STATUS_MESSAGES[status] ?? 'The request could not be completed.';
  return c.json({ error: message, code }, status as ContentfulStatusCode);
}

/**
 * Build the work review routes, mounted inside the document routes so they
 * share that group's body limit and its `/api/canvas/docs` claim.
 *
 * @param source - The document channel, read per request; `undefined` answers 503.
 * @param activity - The Activity feed, read per request; absent writes nothing.
 */
export function createCanvasDocWorkReviewRoutes(
  source: DocChannelHttpSource,
  activity: () => Pick<ActivityService, 'emit'> | undefined = () => undefined
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  function review() {
    const deps = source();
    if (!deps?.workReview)
      throw Object.assign(new Error(), { code: 'DOC_CHANNEL_UNAVAILABLE', status: 503 });
    return { review: deps.workReview, actor: deps.actor };
  }

  function params(c: Context<ApiEnv>): { id: string; batchId: string } {
    if (Object.keys(readQuery(c)).length) throw new z.ZodError([]);
    return {
      id: IdSchema.parse(c.req.param('id')),
      batchId: IdSchema.parse(c.req.param('batchId')),
    };
  }

  /** The person bars, before anything is read off the body. */
  function personOrRefuse(c: Context<ApiEnv>): DocRoutePersonDecision | Response {
    const result = decideAsPerson(honoRequestFacts(c), 'unfinished document work');
    if ('decision' in result) return result.decision;
    const { status, error, code } = result.refusal;
    return c.json({ error, code }, status as ContentfulStatusCode);
  }

  /** One line per replay or clear, naming who did it by the permission honesty rule. */
  function audit(
    decision: DocRoutePersonDecision,
    documentId: string,
    change: CanvasDocWorkChange
  ): void {
    const feed = activity();
    if (!feed) return;
    const { writer, who } = writerFor(decision);
    const metadata: DocWorkReviewedMetadata = {
      documentId,
      routeId: change.routeId,
      batchId: change.batchId,
      action: change.action,
      previousStatus: change.previousStatus,
      posture: decision.posture,
    };
    const what =
      change.action === 'replayed'
        ? change.previousStatus === 'in_doubt'
          ? 'ran uncertain document work again'
          : 'ran expired document work again'
        : change.previousStatus === 'in_doubt'
          ? 'cleared uncertain document work'
          : 'cleared expired document work';
    void feed.emit({
      actorType: writer.actorType,
      actorLabel: writer.actorLabel,
      ...(writer.actorId ? { actorId: writer.actorId } : {}),
      category: 'permissions',
      eventType: DOC_WORK_REVIEWED_EVENT,
      resourceType: 'canvas_document',
      resourceId: documentId,
      resourceLabel: change.routeId,
      summary: `${who} ${what} on route ${change.routeId}`,
      linkPath: null,
      metadata: metadata as unknown as Record<string, unknown>,
    });
  }

  router.get('/:id/work', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      if (Object.keys(readQuery(c)).length) throw new z.ZodError([]);
      const id = IdSchema.parse(c.req.param('id'));
      const { review: service, actor } = review();
      return c.json(await service.list(id, actor(honoRequestFacts(c))));
    } catch (error) {
      return failure(c, error);
    }
  });

  for (const action of ['replay', 'clear'] as const) {
    router.post(`/:id/work/:batchId/${action}`, async (c) => {
      c.header('Cache-Control', 'no-store');
      const person = personOrRefuse(c);
      if (person instanceof Response) return person;
      try {
        const { id, batchId } = params(c);
        const { review: service, actor } = review();
        const change = await service[action](
          id,
          batchId,
          readJsonBody(c, { emptyAs: {} }),
          actor(honoRequestFacts(c)),
          person
        );
        audit(person, id, change);
        return c.json(change);
      } catch (error) {
        return failure(c, error);
      }
    });
  }

  return router;
}

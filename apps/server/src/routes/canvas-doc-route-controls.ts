/**
 * A person's route controls for one canvas document, under `/api/canvas/docs`.
 *
 * - `GET  /:id/routes` — every declared route with its state
 * - `POST /:id/routes/:routeId/review` — the exact details allowing it would bind
 * - `POST /:id/routes/:routeId/approve` — allow a reviewed route
 * - `POST /:id/routes/:routeId/revoke` — turn a route off, every grant it holds
 *
 * Every one needs the operator principal the document routes already resolve
 * (`DocChannelHttp.actor`), so login, the session gate and scope authorization
 * apply exactly as they do to the document's events. The writes also need the
 * person bars an approval decision needs, and the service will not act without
 * the decision those bars mint (`route-controls/person-decision.ts`): without
 * them an agent could allow its own route to another agent from here, which is
 * the one thing `approve_doc_route` exists to stop.
 *
 * Allowing and turning off each write one `permission.answered` Activity line,
 * as an answer on `/api/approvals` does, so a change made here is on the record.
 *
 * @module routes/canvas-doc-route-controls
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  PERMISSION_ANSWERED_EVENT,
  type PermissionAnsweredMetadata,
} from '@dorkos/shared/permissions';
import type { CanvasDocRoute } from '@dorkos/shared/canvas-doc-routes';
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
import { writerForPosture } from './permissions.js';
import type { DocChannelHttpSource } from './canvas-doc-events.js';

const IdSchema = z.string().min(1).max(200);

/** One honest sentence per refusal code; a code not listed falls back by status. */
const CODE_MESSAGES: Record<string, string> = {
  INVALID_DOC_ROUTE_REQUEST: 'The route request is not valid.',
  PERSON_REQUIRED: 'Only a person in DorkOS can change document routes.',
  ROUTE_UNDECLARED: 'This document does not declare that route.',
  ROUTE_CHANGED: 'The route changed since you reviewed it. Review it again.',
  ROUTE_ALREADY_ON: 'This route is already on.',
  ROUTE_ALREADY_GRANTED: 'This route is already on.',
  GRANT_BINDING_CHANGED: 'The route changed while it was being allowed. Review it again.',
  DECLARATION_HASH_MISMATCH: 'The document’s routes changed. Review it again.',
  MANIFEST_CHANGED: 'The document’s app changed. Review it again.',
  GRANT_EXPIRED: 'That end time has already passed. Pick a later one.',
  TARGET_UNAVAILABLE: 'The agent for this route is not available.',
  TARGET_IDENTITY_MISMATCH: 'The agent for this route is not available.',
  TARGET_SCOPE_MISMATCH: 'The agent for this route is not available.',
  ROOM_ROUTE_UNAVAILABLE: 'This room cannot take document events right now.',
  ORIGIN_AUTHORITY_LOST: 'The agent that opened this document is not available.',
  APPROVAL_NOT_RECORDED: 'The approval could not be recorded. Nothing was allowed.',
  LOCAL_SOURCE_UNAVAILABLE: 'The document’s source folder is not available.',
  CANVAS_DOCUMENT_NOT_FOUND: 'The document is not available.',
  DOC_CHANNEL_UNAVAILABLE: 'Document routes are not available yet.',
};
const STATUS_MESSAGES: Record<number, string> = {
  400: 'The route request is not valid.',
  401: 'Sign in to change document routes.',
  403: 'This route cannot be changed right now.',
  404: 'The document or route is not available.',
  409: 'The route changed. Review it again.',
  422: 'The app does not accept this route.',
  503: 'Document routes are not available yet.',
};

/** Translate a refusal without echoing private paths, identities or evidence. */
function failure(c: Context<ApiEnv>, error: unknown): Response {
  const refusal = error as { code?: unknown; status?: unknown };
  let status =
    typeof refusal?.status === 'number' && refusal.status >= 400 && refusal.status <= 599
      ? refusal.status
      : 500;
  let code = typeof refusal?.code === 'string' ? refusal.code : 'DOC_ROUTE_FAILED';
  if (error instanceof z.ZodError) {
    status = 400;
    code = 'INVALID_DOC_ROUTE_REQUEST';
  } else if (refusal?.code === 'AGENT_IDENTITY_UNVERIFIED') status = 401;
  else if (refusal?.code === 'INVALID_APP_MANIFEST') status = 422;
  if (status === 500) logger.error('[canvas-doc-route-controls] request failed', error);
  const message =
    CODE_MESSAGES[code] ?? STATUS_MESSAGES[status] ?? 'The route request could not be completed.';
  return c.json({ error: message, code }, status as ContentfulStatusCode);
}

/** Where a route's events go, for the Activity line. */
function destinationWords(route: CanvasDocRoute): string {
  const d = route.destination;
  if (d.kind === 'log') return 'kept on the document';
  if (d.kind === 'room') return d.agentName ? `${d.agentName} in this room` : 'this room';
  return d.agentName ?? (d.kind === 'owner' ? 'the agent that opened it' : 'an agent');
}

/**
 * Build the route-control routes, mounted inside the document routes so they
 * share that group's body limit and its `/api/canvas/docs` claim.
 *
 * @param source - The document channel, read per request; `undefined` answers 503.
 * @param activity - The Activity feed, read per request; absent writes nothing.
 */
export function createCanvasDocRouteControlRoutes(
  source: DocChannelHttpSource,
  activity: () => Pick<ActivityService, 'emit'> | undefined = () => undefined
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  function controls() {
    const deps = source();
    if (!deps?.routeControls)
      throw Object.assign(new Error(), { code: 'DOC_CHANNEL_UNAVAILABLE', status: 503 });
    return { controls: deps.routeControls, actor: deps.actor };
  }

  function params(c: Context<ApiEnv>): { id: string; routeId: string } {
    if (Object.keys(readQuery(c)).length) throw new z.ZodError([]);
    return {
      id: IdSchema.parse(c.req.param('id')),
      routeId: IdSchema.parse(c.req.param('routeId')),
    };
  }

  /** The person bars, before anything is read off the body. */
  function personOrRefuse(c: Context<ApiEnv>): DocRoutePersonDecision | Response {
    const result = decideAsPerson(honoRequestFacts(c));
    if ('decision' in result) return result.decision;
    const { status, error, code } = result.refusal;
    return c.json({ error, code }, status as ContentfulStatusCode);
  }

  /** One `permission.answered` line for a person's allow or turn off. */
  function audit(
    decision: DocRoutePersonDecision,
    documentId: string,
    route: CanvasDocRoute,
    answer: 'once' | 'deny',
    approvalId: string
  ): void {
    const feed = activity();
    if (!feed) return;
    const writer = writerForPosture(decision.posture, decision.user);
    const who = writer.attribution === 'signed-in' ? 'You' : writer.actorLabel;
    const metadata: PermissionAnsweredMetadata = {
      action: answer === 'once' ? 'ui.approve_doc_route' : 'ui.revoke_doc_route',
      area: null,
      answer,
      approvalId,
      blockedRequest: false,
      posture: decision.posture,
    };
    void feed.emit({
      actorType: writer.actorType,
      actorLabel: writer.actorLabel,
      ...(writer.actorId ? { actorId: writer.actorId } : {}),
      category: 'permissions',
      eventType: PERMISSION_ANSWERED_EVENT,
      resourceType: 'canvas_document',
      resourceId: documentId,
      resourceLabel: route.id,
      summary:
        answer === 'once'
          ? `${who} allowed document events on route ${route.id}: ${destinationWords(route)}`
          : `${who} turned off document events on route ${route.id}`,
      linkPath: null,
      metadata: metadata as unknown as Record<string, unknown>,
    });
  }

  router.get('/:id/routes', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      if (Object.keys(readQuery(c)).length) throw new z.ZodError([]);
      const id = IdSchema.parse(c.req.param('id'));
      const { controls: service, actor } = controls();
      return c.json(await service.list(id, actor(honoRequestFacts(c))));
    } catch (error) {
      return failure(c, error);
    }
  });

  router.post('/:id/routes/:routeId/review', async (c) => {
    c.header('Cache-Control', 'no-store');
    const person = personOrRefuse(c);
    if (person instanceof Response) return person;
    try {
      const { id, routeId } = params(c);
      const { controls: service, actor } = controls();
      return c.json(
        await service.review(id, routeId, readJsonBody(c), actor(honoRequestFacts(c)), person)
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  router.post('/:id/routes/:routeId/approve', async (c) => {
    c.header('Cache-Control', 'no-store');
    const person = personOrRefuse(c);
    if (person instanceof Response) return person;
    try {
      const { id, routeId } = params(c);
      const { controls: service, actor } = controls();
      const { route, approvalId } = await service.approve(
        id,
        routeId,
        readJsonBody(c),
        actor(honoRequestFacts(c)),
        person
      );
      audit(person, id, route, 'once', approvalId);
      return c.json({ route });
    } catch (error) {
      return failure(c, error);
    }
  });

  router.post('/:id/routes/:routeId/revoke', async (c) => {
    c.header('Cache-Control', 'no-store');
    const person = personOrRefuse(c);
    if (person instanceof Response) return person;
    try {
      const { id, routeId } = params(c);
      const { controls: service, actor } = controls();
      const { route, revokedGrantIds } = await service.revoke(
        id,
        routeId,
        readJsonBody(c, { emptyAs: {} }),
        actor(honoRequestFacts(c)),
        person
      );
      for (const grantId of revokedGrantIds) audit(person, id, route, 'deny', grantId);
      return c.json({ route });
    } catch (error) {
      return failure(c, error);
    }
  });

  return router;
}

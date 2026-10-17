/**
 * A person's route controls for one canvas document, under `/api/canvas/docs`.
 *
 * - `GET  /:id/routes` — every declared route with its state
 * - `POST /:id/routes/:routeId/review` — the exact details allowing it would bind
 * - `POST /:id/routes/:routeId/approve` — allow a reviewed route
 * - `POST /:id/routes/:routeId/revoke` — turn a route's grant off
 *
 * Every one needs the operator principal the document routes already resolve
 * (`DocChannelHttp.actor`), so login, the session gate and scope authorization
 * apply exactly as they do to the document's events. The two writes also need
 * the person bars an approval decision needs (`routes/approvals.ts`): a caller
 * that names itself an agent or holds an approval token is refused in every
 * posture, and with login on only a session cookie counts. Without those bars an
 * agent could allow its own route to another agent from here, which is the one
 * thing `approve_doc_route` exists to stop.
 *
 * @module routes/canvas-doc-route-controls
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import type { DocRouteDecider } from '../services/canvas/doc-channel/route-controls/controls.js';
import { logger } from '../lib/logger.js';
import type { DocChannelHttpSource } from './canvas-doc-events.js';

const IdSchema = z.string().min(1).max(200);

/** One plain sentence per status; the code carries the specific reason. */
const MESSAGES: Record<number, string> = {
  400: 'The route request is not valid.',
  401: 'Sign in to change document routes.',
  403: 'Only a person in DorkOS can change document routes.',
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
  return c.json(
    { error: MESSAGES[status] ?? 'The route request could not be completed.', code },
    status as ContentfulStatusCode
  );
}

/**
 * The person bars, before anything is read off the body.
 *
 * @returns The decider, or the refusal to answer with.
 */
function personOrRefuse(c: Context<ApiEnv>): DocRouteDecider | Response {
  const facts = honoRequestFacts(c);
  const authority = resolveDecisionAuthority(readCallerAuthority(facts));
  if (!authority.allowed)
    return c.json(
      { error: authority.error, code: authority.code },
      authority.status as ContentfulStatusCode
    );
  const notAPerson = requireOperatorCookieUnderLogin(facts, 'which document routes are on');
  if (notAPerson)
    return c.json(
      { error: notAPerson.error, code: notAPerson.code },
      notAPerson.status as ContentfulStatusCode
    );
  return authority.posture === 'signed-in-operator' ? { decidedByUserId: authority.decidedBy } : {};
}

/**
 * Build the route-control routes, mounted inside the document routes so they
 * share that group's body limit and its `/api/canvas/docs` claim.
 *
 * @param source - The document channel, read per request; `undefined` answers 503.
 */
export function createCanvasDocRouteControlRoutes(source: DocChannelHttpSource): Hono<ApiEnv> {
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
      return c.json(await service.review(id, routeId, readJsonBody(c), actor(honoRequestFacts(c))));
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
      return c.json(
        await service.approve(id, routeId, readJsonBody(c), actor(honoRequestFacts(c)), person)
      );
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
      return c.json(await service.revoke(id, routeId, readJsonBody(c), actor(honoRequestFacts(c))));
    } catch (error) {
      return failure(c, error);
    }
  });

  return router;
}

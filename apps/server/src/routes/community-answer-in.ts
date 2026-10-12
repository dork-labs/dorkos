/**
 * Where any person's post in a space wakes the owner's agents without a mention (spec
 * `official-community-space` D11): `GET` and `PUT /api/community-connections/:ref/answer-in`.
 *
 * Owner-only, like every connection route: the owner check it is handed
 * (`resolveCommunityOwner`) refuses an agent's identity,
 * a remote caller and anyone but this install's owner, and no DorkOS tool or config key reaches
 * the setting. (With login off, an agent's own shell on this machine is the local-trust
 * residual, and a stranger's turn asks before it runs one.)
 *
 * @module routes/community-answer-in
 */
import type { Context, Hono } from 'hono';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import {
  COMMUNITY_ANSWER_IN_MAX,
  CommunityAnswerInSchema,
} from '@dorkos/shared/community-connections';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { RemoteConnectionNotFoundError } from '../services/communities/remote/connection-store.js';
import type { RemoteWakePolicy } from '../services/communities/remote/wake/wake-policy.js';

/** The part of the wake policy these routes read and write. */
export type AnswerInPolicy = Pick<RemoteWakePolicy, 'getAnswerIn' | 'setAnswerIn'>;

/**
 * Add the answer-in routes to the connection routes.
 *
 * @param router - The `/api/community-connections` routes.
 * @param resolveCommunityOwner - The connection routes' owner check: the owner's id, or the
 *   refusal to answer with.
 * @param policy - Looked up per request, so building the routes reads nothing from disk.
 */
export function addAnswerInRoutes(
  router: Hono<ApiEnv>,
  resolveCommunityOwner: (c: Context<ApiEnv>) => string | Response,
  policy: () => AnswerInPolicy
): void {
  router.get('/:ref/answer-in', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
    if (!ref.success) return notFound(c);
    try {
      return c.json(
        CommunityAnswerInSchema.parse({ answerIn: await policy().getAnswerIn(ref.data, owner) })
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  router.put('/:ref/answer-in', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
    if (!ref.success) return notFound(c);
    const body = CommunityAnswerInSchema.safeParse(readJsonBody(c));
    if (!body.success) {
      return c.json(
        { error: `List up to ${COMMUNITY_ANSWER_IN_MAX} channel names, like help or welcome.` },
        400
      );
    }
    try {
      await policy().setAnswerIn(ref.data, owner, body.data.answerIn);
      return c.json(body.data);
    } catch (error) {
      return failure(c, error);
    }
  });
}

function notFound(c: Context): Response {
  return c.json({ error: 'Space connection not found.' }, 404);
}

function failure(c: Context, error: unknown): Response {
  if (error instanceof RemoteConnectionNotFoundError) return notFound(c);
  return c.json({ error: 'Could not save where your agents answer. Try again.' }, 500);
}

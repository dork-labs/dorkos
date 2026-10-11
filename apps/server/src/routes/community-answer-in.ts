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
import type { Request, Response, Router } from 'express';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import {
  COMMUNITY_ANSWER_IN_MAX,
  CommunityAnswerInSchema,
} from '@dorkos/shared/community-connections';
import { RemoteConnectionNotFoundError } from '../services/communities/remote/connection-store.js';
import type { RemoteWakePolicy } from '../services/communities/remote/wake/wake-policy.js';

/** The part of the wake policy these routes read and write. */
export type AnswerInPolicy = Pick<RemoteWakePolicy, 'getAnswerIn' | 'setAnswerIn'>;

/**
 * Add the answer-in routes to the connection router.
 *
 * @param router - The `/api/community-connections` router.
 * @param resolveCommunityOwner - The connection routes' owner check: the owner's id, or `null`
 *   once it has answered the refusal.
 * @param policy - Looked up per request, so building the router reads nothing from disk.
 */
export function addAnswerInRoutes(
  router: Router,
  resolveCommunityOwner: (req: Request, res: Response) => string | null,
  policy: () => AnswerInPolicy
): void {
  router.get('/:ref/answer-in', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!ref.success) return notFound(res);
    try {
      res.json(
        CommunityAnswerInSchema.parse({ answerIn: await policy().getAnswerIn(ref.data, owner) })
      );
    } catch (error) {
      failure(res, error);
    }
  });
  router.put('/:ref/answer-in', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!ref.success) return notFound(res);
    const body = CommunityAnswerInSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: `List up to ${COMMUNITY_ANSWER_IN_MAX} channel names, like help or welcome.`,
      });
      return;
    }
    try {
      await policy().setAnswerIn(ref.data, owner, body.data.answerIn);
      res.json(body.data);
    } catch (error) {
      failure(res, error);
    }
  });
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'Space connection not found.' });
}

function failure(res: Response, error: unknown): void {
  if (error instanceof RemoteConnectionNotFoundError) notFound(res);
  else res.status(500).json({ error: 'Could not save where your agents answer. Try again.' });
}

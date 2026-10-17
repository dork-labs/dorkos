/**
 * The owner's monthly limit on what teammates' turns in one space may cost (DOR-2956, the card
 * limit), and this month's spending there:
 *
 * - `GET /api/community-connections/:ref/teammate-spend`
 * - `PUT /api/community-connections/:ref/teammate-spend {monthlyLimitUsd}` (`null` clears it)
 *
 * Owner-only, like every route on this router: `resolveCommunityOwner` refuses an agent's
 * identity, a remote caller and anyone but this install's owner, and no DorkOS tool or config key
 * reaches it.
 *
 * @module routes/community-teammate-spend
 */
import type { Context, Hono } from 'hono';
import { CommunityRefSchema, type CommunityRef } from '@dorkos/shared/community-adapter';
import {
  CommunityTeammateSpendLimitRequestSchema,
  CommunityTeammateSpendSchema,
} from '@dorkos/shared/community-teammates';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { RemoteConnectionNotFoundError } from '../services/communities/remote/connection-store.js';
import type { TeammateSpend } from '../services/communities/remote/wake/teammate-spend.js';
import { getRemoteCommunityEnrollmentStore } from '../services/communities/remote/state.js';

/** What the routes need of the spending counter. */
export type TeammateSpendPolicy = Pick<TeammateSpend, 'summary' | 'setLimit'>;

/** Whether the owner has an agent enrolled in a space, from this install's own records. */
export type HasAgentsHere = (ref: CommunityRef, owner: string) => boolean;

/** This install's enrollments say so; none known reads as none. */
const enrolledHere: HasAgentsHere = (ref, owner) => {
  try {
    return getRemoteCommunityEnrollmentStore().activeForOwner(ref, owner).length > 0;
  } catch {
    return false;
  }
};

/**
 * Register the teammate-spend routes on the community-connections router.
 *
 * @param router - The `/api/community-connections` routes.
 * @param resolveCommunityOwner - This install's owner, or the refusal for anyone else.
 * @param spend - The spending counter.
 * @param hasAgentsHere - Whether the owner has an agent enrolled in a space.
 */
export function addTeammateSpendRoutes(
  router: Hono<ApiEnv>,
  resolveCommunityOwner: (c: Context<ApiEnv>) => string | Response,
  spend: () => TeammateSpendPolicy,
  hasAgentsHere: HasAgentsHere = enrolledHere
): void {
  const read = async (ref: CommunityRef, owner: string) =>
    CommunityTeammateSpendSchema.parse({
      ...(await spend().summary(ref, owner)),
      hasAgentsHere: hasAgentsHere(ref, owner),
    });
  router.get('/:ref/teammate-spend', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
    if (!ref.success) return notFound(c);
    try {
      return c.json(await read(ref.data, owner));
    } catch (error) {
      return failure(c, error);
    }
  });
  router.put('/:ref/teammate-spend', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
    if (!ref.success) return notFound(c);
    const body = CommunityTeammateSpendLimitRequestSchema.safeParse(readJsonBody(c));
    if (!body.success)
      return c.json({ error: 'Enter a monthly limit of at least $0.01, or none.' }, 400);
    try {
      await spend().setLimit(ref.data, owner, body.data.monthlyLimitUsd);
      return c.json(await read(ref.data, owner));
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
  return c.json({ error: 'Could not save the monthly limit. Try again.' }, 500);
}

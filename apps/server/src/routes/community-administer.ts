/**
 * Whether the app can manage a connected space for its person (DOR-3005):
 *
 * - `GET /api/community-connections/:ref/administer` → `{ canAdminister, administerAvailable }`
 *
 * `canAdminister` is true when this connection holds the space's manage credential, which an
 * owner or admin gives the app by ticking the consent line when they pair. `administerAvailable`
 * is true when the space offers that credential, so an owner or admin without it can pair again
 * to manage the space here. Neither returns the credential.
 *
 * Owner-only, like every route on this router: `resolveCommunityOwner` refuses an agent's
 * identity, a remote caller and anyone but this install's owner.
 *
 * @module routes/community-administer
 */
import type { Context, Hono } from 'hono';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import { CommunityConnectionAdministerSchema } from '@dorkos/shared/community-administer';
import type { ApiEnv } from '../http/api-chain.js';
import { RemoteConnectionNotFoundError } from '../services/communities/remote/connection-store.js';
import type { RemoteAdministerCredentials } from '../services/communities/remote/administer/administer-credentials.js';

/** What the route needs of the manage credentials: whether one is held, never the credential. */
export type AdministerState = Pick<RemoteAdministerCredentials, 'state'>;

/**
 * Register the administer route on the community-connections router.
 *
 * @param router - The `/api/community-connections` routes.
 * @param resolveCommunityOwner - This install's owner, or the refusal for anyone else.
 * @param administer - The manage credentials.
 */
export function addAdministerRoutes(
  router: Hono<ApiEnv>,
  resolveCommunityOwner: (c: Context<ApiEnv>) => string | Response,
  administer: () => AdministerState
): void {
  router.get('/:ref/administer', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
    if (!ref.success) return notFound(c);
    try {
      return c.json(
        CommunityConnectionAdministerSchema.parse(await administer().state(ref.data, owner))
      );
    } catch (error) {
      if (error instanceof RemoteConnectionNotFoundError) return notFound(c);
      return c.json({ error: 'Could not check this space. Try again.' }, 500);
    }
  });
}

function notFound(c: Context): Response {
  return c.json({ error: 'Space connection not found.' }, 404);
}

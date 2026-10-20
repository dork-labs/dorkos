/**
 * A connected space's settings, for its Settings tab (DOR-3005):
 * `GET /api/community-connections/:ref/space/{settings,me,members,rules}`.
 *
 * Read-only, and for the person who owns this install only. On top of the connection routes'
 * owner check (`resolveCommunityOwner`, which refuses an agent's identity, a remote caller and
 * anyone but this install's owner), these refuse every caller that is not that person at the app:
 * an agent's `X-DorkOS-Agent`, an approval token, an API key or any other bearer, and a request
 * from a mini app's sandboxed frame. The four paths are fixed; the space is reached through
 * {@link SpaceSettingsReader}, which holds the connection's grant and never returns it.
 *
 * @module routes/community-space-settings
 */
import type { Context, Hono } from 'hono';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import {
  COMMUNITY_SPACE_READS,
  COMMUNITY_SPACE_READ_SCHEMAS,
} from '@dorkos/shared/community-space-settings';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionNotFoundError,
} from '../services/communities/remote/connection-store.js';
import {
  SpaceReadRefusedError,
  type SpaceSettingsReader,
} from '../services/communities/remote/settings/index.js';

/**
 * Why this caller is not the person at the app, or `undefined` when it is. Read before the owner
 * check, so a refused caller learns nothing about which connections exist.
 *
 * @param c - The request's context.
 */
export function refuseNonPerson(c: Context<ApiEnv>): string | undefined {
  const facts = honoRequestFacts(c);
  if (presentsAgentIdentity(facts) || facts.headers[APPROVAL_TOKEN_HEADER] !== undefined)
    return 'Only a person can read a space’s settings, not an agent.';
  if (facts.user?.credential === 'api-key' || facts.headers.authorization !== undefined)
    return 'Read a space’s settings in the app, not with a key.';
  // A mini app's sandboxed frame has no origin of its own and is never same-site.
  if (facts.headers.origin === 'null' || facts.headers['sec-fetch-site'] === 'cross-site')
    return 'Read a space’s settings in the app itself.';
  return undefined;
}

/**
 * Add the four space settings reads to the connection routes.
 *
 * @param router - The `/api/community-connections` routes.
 * @param resolveCommunityOwner - The connection routes' owner check.
 * @param reader - Looked up per request, so building the routes reads nothing from disk.
 */
export function addSpaceSettingsRoutes(
  router: Hono<ApiEnv>,
  resolveCommunityOwner: (c: Context<ApiEnv>) => string | Response,
  reader: () => SpaceSettingsReader
): void {
  for (const read of COMMUNITY_SPACE_READS) {
    router.get(`/:ref/space/${read}`, async (c) => {
      const refused = refuseNonPerson(c);
      if (refused) return c.json({ error: refused, code: 'NOT_A_PERSON' }, 403);
      const owner = resolveCommunityOwner(c);
      if (typeof owner !== 'string') return owner;
      const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
      if (!ref.success) return c.json({ error: 'Space connection not found.' }, 404);
      try {
        const result = await reader().read(ref.data, owner, read);
        c.header('Cache-Control', 'no-store');
        return c.json(COMMUNITY_SPACE_READ_SCHEMAS[read].parse(result));
      } catch (error) {
        if (error instanceof SpaceReadRefusedError)
          return c.json({ error: error.sentence, code: error.code }, error.status);
        if (error instanceof RemoteConnectionAuthorizationError)
          return c.json(
            { error: 'Reconnect this space to continue.', code: 'COMMUNITY_RECONNECT_REQUIRED' },
            409
          );
        if (error instanceof RemoteConnectionNotFoundError)
          return c.json({ error: 'Space connection not found.' }, 404);
        return c.json({ error: 'The space connection is unavailable.' }, 502);
      }
    });
  }
}

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
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import {
  COMMUNITY_SPACE_READS,
  COMMUNITY_SPACE_READ_SCHEMAS,
} from '@dorkos/shared/community-space-settings';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { assessPerson, type PersonBarCopy, type PersonRefusal } from './extensions-person-bar.js';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionNotFoundError,
} from '../services/communities/remote/connection-store.js';
import {
  SpaceReadRefusedError,
  type SpaceSettingsReader,
} from '../services/communities/remote/settings/index.js';

/** What these reads say when the caller is not the person at the app. */
const PERSON_BAR: PersonBarCopy = {
  error: 'Only a person can read a space’s settings, in the app.',
  code: 'NOT_A_PERSON',
  subject: 'a space’s settings',
  crossSite: (origin) => `A page on ${origin} tried to read a space’s settings.`,
  agent: 'Only a person can read a space’s settings, not an agent.',
};

/**
 * The person bar every person-only route shares (`assessPerson`: another site's page, an agent's
 * identity or an approval token, and anything but a browser session under login), and one more:
 * no bearer of any kind, so an API key never reads a space's settings in any posture. Run before
 * the owner check, so a refused caller learns nothing about which connections exist.
 *
 * @param c - The request's context.
 * @returns The refusal to answer with, or `null` when the person at the app is asking.
 */
export function refuseNonPerson(c: Context<ApiEnv>): PersonRefusal | null {
  const facts = honoRequestFacts(c);
  const refusal = assessPerson(facts, PERSON_BAR);
  if (refusal) return refusal;
  if (facts.user?.credential === 'api-key' || facts.headers.authorization !== undefined)
    return {
      status: 403,
      body: {
        error: PERSON_BAR.error,
        code: PERSON_BAR.code,
        message: 'Read a space’s settings in the app, not with a key.',
      },
    };
  return null;
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
      // Nothing here, answer or refusal, is for any cache between the app and this server.
      c.header('Cache-Control', 'no-store');
      const refused = refuseNonPerson(c);
      if (refused) return c.json(refused.body, refused.status as ContentfulStatusCode);
      const owner = resolveCommunityOwner(c);
      if (typeof owner !== 'string') return owner;
      const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
      if (!ref.success) return c.json({ error: 'Space connection not found.' }, 404);
      try {
        const result = await reader().read(ref.data, owner, read);
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

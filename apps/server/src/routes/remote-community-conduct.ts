/**
 * A person's own side of a space's moderation, proxied to its Community (DOR-2770): whether they
 * may post in a channel now (a mute, slow mode, the rules), accepting the rules, their name in
 * the space, and reporting someone else's message.
 *
 * Each is the person's own business, so each also clears the agent bar: an agent on this
 * computer, even one holding the owner's key, cannot read the owner's standing, agree to a
 * space's rules, pick the owner's name or file a report as them. The Community refuses an agent
 * credential on the same routes. The adapter sends every one on the owner's own grant and never
 * as an enrolled agent.
 *
 * @module routes/remote-community-conduct
 */
import type { Context, Hono } from 'hono';
import {
  RemoteCommunityDisplayNameRequestSchema,
  RemoteCommunityDisplayNameResponseSchema,
  RemoteCommunityReportRequestSchema,
  RemoteCommunityRulesAcceptRequestSchema,
  RemoteCommunityRulesResponseSchema,
  RemoteCommunityStandingSchema,
} from '@dorkos/shared/community-views';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { getRemoteCommunityAdapter } from '../services/communities/remote/state.js';
import {
  communityFailure,
  communityTarget,
  verifiedConnection,
  type CommunityTarget,
} from './remote-community-http.js';

/** The owner and the space, or the refusal: the owner's bars, then the agent bar. */
function resolve(c: Context<ApiEnv>): CommunityTarget | Response {
  const target = communityTarget(c);
  if (target instanceof Response) return target;
  if (!clearsTheAgentBar(honoRequestFacts(c))) {
    return c.json(
      {
        code: 'COMMUNITY_PERSON_REQUIRED',
        error: 'Only you can do this in a space, not an agent.',
      },
      403
    );
  }
  return target;
}

/**
 * Register the conduct routes on the remote-communities routes.
 *
 * @param router - The `/api/communities` routes.
 */
export function registerRemoteCommunityConductRoutes(router: Hono<ApiEnv>): void {
  router.get('/:ref/rooms/:roomId/standing', async (c) => {
    const target = resolve(c);
    if (target instanceof Response) return target;
    const roomId = c.req.param('roomId');
    try {
      await verifiedConnection(target.ref, target.owner, 'read');
      const standing = await getRemoteCommunityAdapter(target.ref, target.owner).getStanding(
        roomId
      );
      return c.json(
        RemoteCommunityStandingSchema.parse({ community: target.ref, roomId, ...standing })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });

  router.post('/:ref/rules/accept', async (c) => {
    const target = resolve(c);
    if (target instanceof Response) return target;
    const input = RemoteCommunityRulesAcceptRequestSchema.safeParse(readJsonBody(c));
    if (!input.success) return c.json({ error: 'Read the rules first.' }, 400);
    try {
      // A space its host holds reads as archived, so the connection cannot post, yet a person may
      // still accept its rules there, which changes nothing anyone sees (DOR-2836). Only reading
      // is checked here then, and the space decides.
      const connection = await verifiedConnection(target.ref, target.owner, 'read');
      if (connection.access?.lastKnown?.lifecycle !== 'archived')
        await verifiedConnection(target.ref, target.owner, 'post');
      const rules = await getRemoteCommunityAdapter(target.ref, target.owner).acceptRules(
        input.data.version
      );
      return c.json(RemoteCommunityRulesResponseSchema.parse({ community: target.ref, rules }));
    } catch (error) {
      return communityFailure(c, error, 'accept-rules');
    }
  });

  router.put('/:ref/me/display-name', async (c) => {
    const target = resolve(c);
    if (target instanceof Response) return target;
    const input = RemoteCommunityDisplayNameRequestSchema.safeParse(readJsonBody(c));
    if (!input.success) {
      return c.json({ error: 'Use letters, numbers and spaces, up to 128.' }, 400);
    }
    try {
      await verifiedConnection(target.ref, target.owner, 'post');
      const member = await getRemoteCommunityAdapter(target.ref, target.owner).setDisplayName(
        input.data.displayName
      );
      return c.json(
        RemoteCommunityDisplayNameResponseSchema.parse({
          community: target.ref,
          displayName: member.displayName,
        })
      );
    } catch (error) {
      return communityFailure(c, error, 'rename');
    }
  });

  router.post('/:ref/rooms/:roomId/entries/:entryId/reports', async (c) => {
    const target = resolve(c);
    if (target instanceof Response) return target;
    const input = RemoteCommunityReportRequestSchema.safeParse(readJsonBody(c));
    if (!input.success) {
      return c.json({ error: 'Pick a reason. Notes are up to 1,000 characters.' }, 400);
    }
    try {
      await verifiedConnection(target.ref, target.owner, 'post');
      await getRemoteCommunityAdapter(target.ref, target.owner).reportEntry(
        c.req.param('roomId'),
        c.req.param('entryId'),
        input.data
      );
      return c.body(null, 204);
    } catch (error) {
      return communityFailure(c, error, 'report');
    }
  });
}

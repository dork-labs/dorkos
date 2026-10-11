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
import type { Request, Response, Router } from 'express';
import { CommunityRefSchema, type CommunityRef } from '@dorkos/shared/community-adapter';
import {
  RemoteCommunityDisplayNameRequestSchema,
  RemoteCommunityDisplayNameResponseSchema,
  RemoteCommunityReportRequestSchema,
  RemoteCommunityRulesAcceptRequestSchema,
  RemoteCommunityRulesResponseSchema,
  RemoteCommunityStandingSchema,
} from '@dorkos/shared/community-views';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { resolveCommunityOwner } from './community-connections.js';
import { getRemoteCommunityAdapter } from '../services/communities/remote/state.js';
import type { CommunityRefusalAction } from './remote-community-refusal.js';

/** The two helpers the remote-communities router shares with these routes. */
export interface RemoteCommunityConductDeps {
  /** Refuse unless the owner's connection is verified and grants `capability`. */
  verifiedConnection: (
    ref: CommunityRef,
    owner: string,
    capability: 'read' | 'post'
  ) => Promise<unknown>;
  /** Answer a failure with the space's refusal in plain words. */
  fail: (res: Response, error: unknown, action?: CommunityRefusalAction) => void;
}

/** The owner and the space, or `null` once the request has been answered. */
function resolve(req: Request, res: Response) {
  const owner = resolveCommunityOwner(req, res);
  const ref = CommunityRefSchema.safeParse(req.params.ref);
  if (!owner || !ref.success) return null;
  if (!clearsTheAgentBar(req, res)) {
    res.status(403).json({
      code: 'COMMUNITY_PERSON_REQUIRED',
      error: 'Only you can do this in a space, not an agent.',
    });
    return null;
  }
  return { owner, ref: ref.data };
}

/**
 * Register the conduct routes on the remote-communities router.
 *
 * @param router - The `/api/communities` router.
 * @param deps - The router's connection check and refusal helper.
 */
export function registerRemoteCommunityConductRoutes(
  router: Router,
  { verifiedConnection, fail }: RemoteCommunityConductDeps
): void {
  router.get('/:ref/rooms/:roomId/standing', async (req, res) => {
    const target = resolve(req, res);
    if (!target) return;
    try {
      await verifiedConnection(target.ref, target.owner, 'read');
      const standing = await getRemoteCommunityAdapter(target.ref, target.owner).getStanding(
        req.params.roomId
      );
      res.json(
        RemoteCommunityStandingSchema.parse({
          community: target.ref,
          roomId: req.params.roomId,
          ...standing,
        })
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/:ref/rules/accept', async (req, res) => {
    const target = resolve(req, res);
    if (!target) return;
    const input = RemoteCommunityRulesAcceptRequestSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Read the rules first.' });
    try {
      await verifiedConnection(target.ref, target.owner, 'post');
      const rules = await getRemoteCommunityAdapter(target.ref, target.owner).acceptRules(
        input.data.version
      );
      res.json(RemoteCommunityRulesResponseSchema.parse({ community: target.ref, rules }));
    } catch (error) {
      fail(res, error, 'accept-rules');
    }
  });

  router.put('/:ref/me/display-name', async (req, res) => {
    const target = resolve(req, res);
    if (!target) return;
    const input = RemoteCommunityDisplayNameRequestSchema.safeParse(req.body);
    if (!input.success)
      return res.status(400).json({ error: 'Use letters, numbers and spaces, up to 128.' });
    try {
      await verifiedConnection(target.ref, target.owner, 'post');
      const member = await getRemoteCommunityAdapter(target.ref, target.owner).setDisplayName(
        input.data.displayName
      );
      res.json(
        RemoteCommunityDisplayNameResponseSchema.parse({
          community: target.ref,
          displayName: member.displayName,
        })
      );
    } catch (error) {
      fail(res, error, 'rename');
    }
  });

  router.post('/:ref/rooms/:roomId/entries/:entryId/reports', async (req, res) => {
    const target = resolve(req, res);
    if (!target) return;
    const input = RemoteCommunityReportRequestSchema.safeParse(req.body);
    if (!input.success)
      return res.status(400).json({ error: 'Pick a reason. Notes are up to 1,000 characters.' });
    try {
      await verifiedConnection(target.ref, target.owner, 'post');
      await getRemoteCommunityAdapter(target.ref, target.owner).reportEntry(
        req.params.roomId,
        req.params.entryId,
        input.data
      );
      res.status(204).end();
    } catch (error) {
      fail(res, error, 'report');
    }
  });
}

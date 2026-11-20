/**
 * Named Agent browser profiles. These sit behind the owner-on-this-computer
 * check in `local-browser.ts`, and adding an agent also waits on "Confirm it's you".
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { LocalBrowserProfileBindSchema } from '@dorkos/shared/local-browser';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { refuseUnlessAccountOwner, requirePersonAtThisComputer } from '../lib/caller-authority.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { holdForStepUp } from './step-up-guard.js';
import type { LocalBrowserProfileStore } from '../services/session/local-browser/profile-store.js';

/** What the profile routes need. */
export interface LocalBrowserProfileRouteDeps {
  profiles: LocalBrowserProfileStore;
  /** Share admission for the explicitly selected agent chat and its live turn. */
  mayShare?(agentId: string, sessionId?: string): Promise<boolean>;
  /** The registered agent with this id and its folder's real path, or undefined. */
  agent(agentId: string): { name: string; projectPath: string } | undefined;
}

const NOT_FOUND = { error: 'That browser profile no longer exists.', code: 'profile_not_found' };
const NO_AGENT = { error: 'That agent no longer exists.', code: 'agent_not_found' };
const OWNER_ONLY = {
  error: 'Only this DorkOS owner, on this computer, can change who uses a profile.',
  code: 'owner_only',
};

/**
 * Add the profile routes to the owner-only browser router.
 *
 * @param router - The browser router, with its person checks already in place.
 * @param deps - The profile records and the agent registry.
 */
export function mountLocalBrowserProfileRoutes(
  router: Hono<ApiEnv>,
  deps: LocalBrowserProfileRouteDeps
): void {
  const { profiles } = deps;
  router.get('/profiles', (c) => c.json({ profiles: profiles.list() }));
  // Named profiles are cut for launch (DOR-4105): the panel can't show one, so no one may
  // make one. A hidden sign-in store is access the person can't see or remove.
  router.post('/profiles', (c) =>
    c.json({ error: 'New browser profiles aren’t available.', code: 'profiles_closed' }, 403)
  );
  router.post('/profiles/:id/agents', async (c) => {
    if (requirePersonAtThisComputer(honoRequestFacts(c)) !== undefined)
      return c.json({ error: 'Only you can share a browser.', code: 'person_only' }, 403);
    const profileId = c.req.param('id');
    const sessionId = z.string().min(1).max(256).optional().parse(c.req.query('sessionId'));
    const { agentId } = LocalBrowserProfileBindSchema.parse(readJsonBody(c));
    const profile = profiles.get(profileId);
    if (!profile) return c.json(NOT_FOUND, 404);
    const agent = deps.agent(agentId);
    if (!agent) return c.json(NO_AGENT, 404);
    if (!sessionId || !(await deps.mayShare?.(agentId, sessionId)))
      return c.json(
        { error: 'Wait until this agent’s turn ends, then share.', code: 'outside_turn' },
        403
      );
    return holdForStepUp(c, {
      kind: 'browser-profile.bind',
      target: profile.label,
      input: { profileId, agentId, sessionId },
      // An agent picks its own name, so the folder says which agent this really is.
      reason: `${agent.name} (${agent.projectPath}) can use everything you’re signed in to in this profile.`,
      // The router's own bar, re-run on the request that confirmed it (DOR-3234): an owner
      // replaced while the sheet was up, or a confirm from off this computer, binds nothing.
      commit: async (confirming) => {
        if (
          !isAtThisComputer(confirming) ||
          refuseUnlessAccountOwner(confirming) !== undefined ||
          requirePersonAtThisComputer(confirming) !== undefined
        )
          return { status: 403, body: OWNER_ONLY };
        if (!profiles.get(profileId)) return { status: 404, body: NOT_FOUND };
        const current = deps.agent(agentId);
        if (!current) return { status: 404, body: NO_AGENT };
        // The person confirmed this folder. An agent that moved since is a new question.
        if (current.projectPath !== agent.projectPath) return { status: 404, body: NO_AGENT };
        if (!sessionId || !(await deps.mayShare?.(agentId, sessionId)))
          return {
            status: 403,
            body: { error: 'Wait until this agent’s turn ends, then share.', code: 'outside_turn' },
          };
        profiles.bind(profileId, agentId, current.projectPath);
        return { status: 200, body: profiles.get(profileId) };
      },
    });
  });
  // The path explicitly names both targets. Narrowing access stays available even
  // during a marked turn, with no share-admission check or step-up.
  router.delete('/profiles/:id/agents/:agentId', async (c) => {
    if (requirePersonAtThisComputer(honoRequestFacts(c)) !== undefined)
      return c.json({ error: 'Only you can change browser sharing.', code: 'person_only' }, 403);
    const profileId = c.req.param('id');
    if (!profiles.get(profileId)) return c.json(NOT_FOUND, 404);
    const agentId = c.req.param('agentId');
    profiles.unbind(profileId, agentId);
    return c.json(profiles.get(profileId));
  });
}

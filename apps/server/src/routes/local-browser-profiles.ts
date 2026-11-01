/**
 * Named Agent browser profiles. These sit behind the owner-on-this-computer
 * check in `local-browser.ts`, and adding an agent also waits on "Confirm it's you".
 */
import type { Hono } from 'hono';
import {
  LocalBrowserProfileBindSchema,
  LocalBrowserProfileCreateSchema,
} from '@dorkos/shared/local-browser';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { holdForStepUp } from './step-up-guard.js';
import type { LocalBrowserProfileStore } from '../services/session/local-browser/profile-store.js';

/** What the profile routes need. */
export interface LocalBrowserProfileRouteDeps {
  profiles: LocalBrowserProfileStore;
  /** The registered agent with this id and its folder's real path, or undefined. */
  agent(agentId: string): { name: string; projectPath: string } | undefined;
}

const NOT_FOUND = { error: 'That browser profile no longer exists.', code: 'profile_not_found' };
const NO_AGENT = { error: 'That agent no longer exists.', code: 'agent_not_found' };

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
  router.post('/profiles', (c) => {
    const { label } = LocalBrowserProfileCreateSchema.parse(readJsonBody(c));
    return c.json(profiles.create(label), 201);
  });
  router.post('/profiles/:id/agents', (c) => {
    const profileId = c.req.param('id');
    const { agentId } = LocalBrowserProfileBindSchema.parse(readJsonBody(c));
    const profile = profiles.get(profileId);
    if (!profile) return c.json(NOT_FOUND, 404);
    const agent = deps.agent(agentId);
    if (!agent) return c.json(NO_AGENT, 404);
    return holdForStepUp(c, {
      kind: 'browser-profile.bind',
      target: profile.label,
      input: { profileId, agentId },
      // An agent picks its own name, so the folder says which agent this really is.
      reason: `Confirm it’s you to let ${agent.name} (${agent.projectPath}) use the sign-ins in ${profile.label}.`,
      commit: async () => {
        if (!profiles.get(profileId)) return { status: 404, body: NOT_FOUND };
        const current = deps.agent(agentId);
        if (!current) return { status: 404, body: NO_AGENT };
        // The person confirmed this folder. An agent that moved since is a new question.
        if (current.projectPath !== agent.projectPath) return { status: 404, body: NO_AGENT };
        profiles.bind(profileId, agentId, current.projectPath);
        return { status: 200, body: profiles.get(profileId) };
      },
    });
  });
  // Taking access away narrows it, so it needs no step-up. The next tool call is refused.
  router.delete('/profiles/:id/agents/:agentId', (c) => {
    const profileId = c.req.param('id');
    if (!profiles.get(profileId)) return c.json(NOT_FOUND, 404);
    profiles.unbind(profileId, c.req.param('agentId'));
    return c.json(profiles.get(profileId));
  });
}

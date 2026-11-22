/** Trusted profile selection for a person's browser open. Never called by an agent tool. */
import type { LocalBrowserOpen, LocalBrowserProfileChoice } from '@dorkos/shared/local-browser';
import { LocalBrowserProfileIdSchema } from '@dorkos/shared/local-browser';
import {
  createLocalBrowserProfileAccess,
  type LocalBrowserProfileAccessDeps,
} from '../profile-access.js';
import type { LocalBrowserProfileStore } from '../profile-store.js';
import { LocalBrowserError } from '../errors.js';

/** Registry facts only; agent names never decide access. */
export interface AgentBrowserProfileDeps extends LocalBrowserProfileAccessDeps {
  profiles: LocalBrowserProfileStore;
  agentName(id: string): string | undefined;
}

/** Build the person-open selector with the same runtime and binding checks as every tool call. */
export function createAgentBrowserProfiles(deps: AgentBrowserProfileDeps) {
  const requireAccess = createLocalBrowserProfileAccess(deps);
  return {
    select: (input: LocalBrowserOpen) => select(input, false),
    initialize: (input: LocalBrowserOpen) => select(input, true),
  };
  async function select(
    input: LocalBrowserOpen,
    initialize: boolean
  ): Promise<LocalBrowserProfileChoice> {
    if (initialize) deps.profiles.ensure('default', 'Your browser');
    if (!input.sessionId) {
      const id = input.profileId ?? 'default';
      const profile = deps.profiles.get(id);
      if (!profile)
        throw new LocalBrowserError('profile_not_found', 'That browser no longer exists.');
      return { id, label: profile.label, agentId: null, agentName: null };
    }
    const folder = await deps.sessionAgent(input.sessionId);
    const agentId = folder ? deps.agentIdAtPath(folder) : undefined;
    const real = folder ? deps.realFolder(folder) : undefined;
    if (!agentId || !real)
      throw new LocalBrowserError('profile_not_allowed', 'This chat has no registered agent.');
    const agentName = deps.agentName(agentId) ?? 'Your agent';
    const ownId = `agent-${agentId}`;
    const label = Array.from(`${agentName} · browser`).slice(0, 80).join('');
    const id = input.profileId ?? ownId;
    LocalBrowserProfileIdSchema.parse(id);
    if (initialize && !input.profileId) {
      // Only a person's open reaches here. Each agent starts with an empty, distinct folder.
      deps.profiles.ensure(id, label);
      if (!deps.profiles.isBound(id, agentId, real)) deps.profiles.bind(id, agentId, real);
    }
    await requireAccess(id, input.sessionId);
    const profile = deps.profiles.get(id);
    if (!profile)
      throw new LocalBrowserError('profile_not_found', 'That browser no longer exists.');
    return { id, label: id === ownId ? label : profile.label, agentId, agentName };
  }
}

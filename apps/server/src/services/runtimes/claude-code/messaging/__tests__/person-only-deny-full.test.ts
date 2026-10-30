/**
 * Full autonomy has no limits (the owner's rule): a launch at Full goes without the rules that
 * keep every agent home's self-grant files from a chat's file tools, and writes one Activity
 * line per chat for it. Below Full the rules stay. DorkOS's own `config.json` stays denied at
 * every level either way (DOR-3068).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import {
  agentHomesSelfGrantRules,
  applyPersonOnlyDataDeny,
  personOnlyFileRules,
} from '../directory-grants.js';
import { setMarkedFullActivity } from '../../../../core/turn-power/full-autonomy.js';

const DORK_HOME = '/Users/ana/.dork';

function denyAt(mode: PermissionMode, sessionId = 'chat-a'): string[] {
  const options: Options = { permissionMode: mode };
  applyPersonOnlyDataDeny(options, DORK_HOME, { sessionId, agentPath: '/agents/scout' });
  return (options.settings as { permissions: { deny: string[] } }).permissions.deny;
}

describe('the agent-home rules on a launch', () => {
  const emit = vi.fn(async () => {});
  beforeEach(() => {
    emit.mockClear();
    setMarkedFullActivity({ emit });
  });
  afterEach(() => setMarkedFullActivity(undefined));

  it.each<PermissionMode>(['default', 'acceptEdits'])('carries them at %s, quietly', (mode) => {
    expect(denyAt(mode)).toEqual(
      expect.arrayContaining(agentHomesSelfGrantRules(DORK_HOME, 'launch'))
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('leaves them off at Full, and keeps config.json denied', () => {
    const rules = denyAt('bypassPermissions', 'chat-full');
    for (const rule of agentHomesSelfGrantRules(DORK_HOME, 'launch')) {
      expect(rules).not.toContain(rule);
    }
    expect(rules).toEqual(expect.arrayContaining(personOnlyFileRules(DORK_HOME)));
  });

  it('writes one Activity line per chat at Full, however many launches', () => {
    denyAt('bypassPermissions', 'chat-once');
    denyAt('bypassPermissions', 'chat-once');
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.full_action',
        resourceId: 'files.agent-homes',
        actorId: '/agents/scout',
      })
    );
  });
});

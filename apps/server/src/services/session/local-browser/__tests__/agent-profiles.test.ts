import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { BrowserProfileAccessGate, createLocalBrowserProfileAccess } from '../profile-access.js';
import { createLocalBrowserProfileStore } from '../profile-store.js';
import { createAgentBrowserProfiles } from '../agent-profiles/agent-profiles.js';

function fixture() {
  const profiles = createLocalBrowserProfileStore(createTestDb(), () => Buffer.alloc(32, 1));
  const deps = {
    profiles,
    resolveSessionRuntime: async () => ({ type: 'test', bound: true }),
    guardsOf: () => ({ protectedPaths: true as const }),
    sessionAgent: async (id: string) => `/agents/${id}`,
    agentIdAtPath: (folder: string) => folder.split('/').at(-1),
    realFolder: (folder: string) => folder,
  };
  const access = createLocalBrowserProfileAccess(deps);
  const selection = createAgentBrowserProfiles({ ...deps, agentName: (id) => id });
  return { profiles, access, selection };
}

describe('agent browser profile choice', () => {
  it('opens each agent in its own signed-out profile, with a binding only for that agent', async () => {
    const { profiles, access, selection } = fixture();
    const a = await selection.initialize({ mode: 'new-window', sessionId: 'atlas' });
    const b = await selection.initialize({ mode: 'embedded', sessionId: 'bolt' });
    expect(a).toMatchObject({ id: 'agent-atlas', label: 'atlas · browser' });
    expect(b).toMatchObject({ id: 'agent-bolt', label: 'bolt · browser' });
    expect(profiles.get('default')?.agentIds).toEqual([]);
    await expect(access(a.id, 'atlas')).resolves.toBeUndefined();
    await expect(access(a.id, 'bolt')).rejects.toMatchObject({ code: 'profile_not_allowed' });
  });

  it('uses the current label when an agent browser already has an older stored name', async () => {
    const { profiles, selection } = fixture();
    profiles.ensure('agent-atlas', 'Old browser name');
    await expect(
      selection.initialize({ mode: 'new-window', sessionId: 'atlas' })
    ).resolves.toMatchObject({
      label: 'atlas · browser',
    });
  });

  it('refuses an explicit profile until shared and immediately after unshare', async () => {
    const { profiles, selection } = fixture();
    await selection.initialize({ mode: 'new-window' });
    const input = { mode: 'embedded' as const, sessionId: 'atlas', profileId: 'default' };
    await expect(selection.initialize(input)).rejects.toMatchObject({
      code: 'profile_not_allowed',
    });
    profiles.bind('default', 'atlas', '/agents/atlas');
    await expect(selection.initialize(input)).resolves.toMatchObject({ id: 'default' });
    profiles.unbind('default', 'atlas');
    await expect(selection.initialize(input)).rejects.toMatchObject({
      code: 'profile_not_allowed',
    });
  });

  it('checks null and default bindings on every agent call', async () => {
    const { access, profiles, selection } = fixture();
    await selection.initialize({ mode: 'new-window' });
    const gate = new BrowserProfileAccessGate();
    gate.use(access, () => true);
    for (const id of [null, 'default']) {
      await expect(gate.require(id, 'atlas')).rejects.toMatchObject({
        code: 'profile_not_allowed',
      });
      profiles.bind('default', 'atlas', '/agents/atlas');
      await expect(gate.require(id, 'atlas')).resolves.toBeUndefined();
      profiles.unbind('default', 'atlas');
    }
  });

  it('refuses an ownerless or unregistered chat without selecting the person’s profile', async () => {
    const { profiles } = fixture();
    const selection = createAgentBrowserProfiles({
      profiles,
      resolveSessionRuntime: async () => ({ type: 'test', bound: true }),
      guardsOf: () => ({ protectedPaths: true }),
      sessionAgent: async () => undefined,
      agentIdAtPath: () => undefined,
      realFolder: () => undefined,
      agentName: () => undefined,
    });
    await expect(
      selection.initialize({ mode: 'embedded', sessionId: 'ownerless' })
    ).rejects.toMatchObject({ code: 'profile_not_allowed' });
    expect(profiles.get('default')?.agentIds).toEqual([]);
  });

  it('keeps the person-alone browser under default without binding any agent', async () => {
    const { profiles, selection } = fixture();
    await expect(selection.initialize({ mode: 'new-window' })).resolves.toMatchObject({
      id: 'default',
      label: 'Your browser',
      agentId: null,
    });
    expect(profiles.get('default')?.agentIds).toEqual([]);
  });
});

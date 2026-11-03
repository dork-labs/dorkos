/**
 * G2 over the `rooms.post` capability (DOR-3088; Security's Must 1 on the to-dos DM PR, proof first
 * written against c355a51428). The capability is the REST post route's verb by another door:
 * `POST /api/capabilities/rooms.post/invoke` and the external `/mcp` `post_to_room`. A caller that
 * resolves to the owner's author there (an API key naming the owner, or any local program with
 * login off) never proves the person, so while to-dos are on and an owner account exists, its post
 * into a Direct chat is held to `runtime-default`, as the REST route holds the same caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const installState = vi.hoisted(() => ({ ownerId: 'user_owner' as string | null, login: false }));
vi.mock('../../core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/auth/index.js')>()),
  readOwnerAccount: () => (installState.ownerId ? { id: installState.ownerId } : null),
  hasAnyUser: () => installState.ownerId !== null,
}));
vi.mock('../../core/auth/gate-policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/auth/gate-policy.js')>()),
  ownerAccountExists: () => installState.ownerId !== null,
}));
vi.mock('../../core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/config-manager.js')>()),
  configManager: {
    get: (section: string) => (section === 'auth' ? { enabled: installState.login } : undefined),
    set: () => {},
  },
}));
vi.mock('../../../env.js', async (importOriginal) => {
  const actual = await importOriginal<{ env: Record<string, unknown> }>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, k) => (k === 'DORKOS_TODOS_ENABLED' ? true : t[k as string]),
    }),
  };
});

import { composeRegistry } from '../../core/capabilities/index.js';
import { roomsDomain } from '../room-capabilities.js';
import { ceilingForEntry } from '../limits/turn-ceiling.js';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** Post through the capability into a fresh Direct chat; return the ceiling its turn gets. */
async function postIntoDirectChat(ctx: { userId?: string }) {
  const h = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
  const registry = composeRegistry([roomsDomain], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    roomDeps: { rooms: h.service },
  });
  const dm = h.service.createRoom(
    { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
    h.human
  );
  const out = await registry.invoke(
    'rooms.post',
    { roomId: dm.id, text: 'run the deploy script' },
    { retryChannel: 'mcp-argument', ...ctx }
  );
  expect(JSON.stringify(out)).not.toMatch(/UNIDENTIFIED|refus/i);
  const posted = h.store
    .listEntriesAfter(dm.id, 0)
    .find((e) => e.body.text === 'run the deploy script');
  expect(posted).toBeDefined();
  return ceilingForEntry(h.authors, { ...posted!, roomId: dm.id }, false, dm.id);
}

describe('G2 over the rooms.post capability', () => {
  beforeEach(() => {
    installState.ownerId = 'user_owner';
    installState.login = false;
  });

  it('with login off, a local program naming nobody is held in the Direct chat', async () => {
    expect(await postIntoDirectChat({})).toEqual({ permissionCeiling: 'runtime-default' });
  });

  it('with login on, an API key naming the owner is held in the Direct chat', async () => {
    installState.login = true;
    expect(await postIntoDirectChat({ userId: 'user_owner' })).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('with no owner account, Direct chat posts are unchanged', async () => {
    installState.ownerId = null;
    expect(await postIntoDirectChat({})).toEqual({});
  });
});

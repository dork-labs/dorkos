/** Adding an agent to a browser profile waits on a person, and changes nothing until then. */
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb } from '@dorkos/test-utils/db';
import { createLocalBrowserProfileStore } from '../../services/session/local-browser/profile-store.js';
import { peekHeldStepUp, takeHeldStepUp } from '../../services/core/auth/step-up/step-up-holds.js';
import { profileLeaseFixture } from '../../services/session/local-browser/__tests__/agent-profile-fixture.js';
import { createBrowserSharePolicy } from '../../services/session/local-browser/agent-profiles/sharing-policy.js';
import {
  mountLocalBrowserProfileRoutes,
  type LocalBrowserProfileRouteDeps,
} from '../local-browser-profiles.js';
import type { ApiEnv } from '../../http/api-chain.js';
import type { RequestFacts } from '../../http/request-facts.js';

/** The request that confirmed the step-up: the same browser session that held it. */
const CONFIRMING = { user: { sessionId: 'sess-a' } } as unknown as RequestFacts;

/** The router's bar as the confirming request meets it: on this computer, and the owner. */
const bar = vi.hoisted(() => ({ atThisComputer: true, owner: true, person: true, marked: false }));
vi.mock('../../services/core/auth/gate-policy.js', () => ({
  isAtThisComputer: () => bar.atThisComputer,
}));
vi.mock('../../lib/caller-authority.js', () => ({
  requirePersonAtThisComputer: () => (bar.person ? undefined : 'agent'),
  refuseUnlessAccountOwner: () => (bar.owner ? undefined : 'not-the-owner'),
}));
vi.mock('../../http/request-facts.js', () => ({
  honoRequestFacts: () => ({ user: { sessionId: 'sess-a' } }),
}));

const agents: Record<string, { name: string; projectPath: string }> = {
  atlas: { name: 'Atlas', projectPath: '/agents/atlas' },
};

function setup(overrides: Partial<LocalBrowserProfileRouteDeps> = {}) {
  const key = randomBytes(32);
  const profiles = overrides.profiles ?? createLocalBrowserProfileStore(createTestDb(), () => key);
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'DELETE')
      c.set('body' as never, (await c.req.json()) as never);
    await next();
  });
  mountLocalBrowserProfileRoutes(app, {
    profiles,
    agent: (id) => agents[id],
    mayShare: async (agentId, sessionId) => !bar.marked && sessionId === `chat-${agentId}`,
    ...overrides,
  });
  const post = (url: string, body: unknown) =>
    app.request(
      url.includes('/agents')
        ? `${url}?sessionId=chat-${(body as { agentId: string }).agentId}`
        : url,
      { method: 'POST', body: JSON.stringify(body) }
    );
  return { profiles, app, post };
}

describe('browser profile routes', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    bar.atThisComputer = true;
    bar.owner = true;
    bar.person = true;
    bar.marked = false;
    t = setup();
  });

  it('re-checks the owner on the confirming request, and binds nothing for anyone else', async () => {
    for (const confirmer of [
      { atThisComputer: true, owner: false },
      { atThisComputer: false, owner: true },
    ]) {
      const profile = t.profiles.create(`Work ${String(confirmer.owner)}`);
      const res = await t.post(`/profiles/${profile.id}/agents`, { agentId: 'atlas' });
      const { heldActionId } = (await res.json()) as { heldActionId: string };
      // The sheet was up; the request that confirms it no longer clears the router's bar.
      Object.assign(bar, confirmer);
      const result = await takeHeldStepUp(heldActionId)!.commit(CONFIRMING);
      Object.assign(bar, { atThisComputer: true, owner: true });
      expect(result).toMatchObject({ status: 403, body: { code: 'owner_only' } });
      expect(t.profiles.isBound(profile.id, 'atlas', '/agents/atlas')).toBe(false);
    }
  });

  it('refuses an agent without creating a step-up card', async () => {
    const profile = t.profiles.create('Example');
    bar.person = false;
    const response = await t.post(`/profiles/${profile.id}/agents`, { agentId: 'atlas' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Only you can share a browser.',
      code: 'person_only',
    });
    expect(t.profiles.get(profile.id)?.agentIds).toEqual([]);
  });

  it('refuses marked turns before asking and again when step-up commits', async () => {
    const profile = t.profiles.create('Example');
    bar.marked = true;
    expect((await t.post(`/profiles/${profile.id}/agents`, { agentId: 'atlas' })).status).toBe(403);
    bar.marked = false;
    const response = await t.post(`/profiles/${profile.id}/agents`, { agentId: 'atlas' });
    const { heldActionId } = (await response.json()) as { heldActionId: string };
    bar.marked = true;
    expect(await takeHeldStepUp(heldActionId)!.commit(CONFIRMING)).toMatchObject({
      status: 403,
      body: { code: 'outside_turn' },
    });
    expect(t.profiles.get(profile.id)?.agentIds).toEqual([]);
  });

  it('holds a bind for step-up and writes nothing until it passes', async () => {
    const profile = t.profiles.create('Work');
    const res = await t.post(`/profiles/${profile.id}/agents`, { agentId: 'atlas' });
    expect(res.status).toBe(428);
    const { heldActionId } = (await res.json()) as { heldActionId: string };
    expect(t.profiles.isBound(profile.id, 'atlas', '/agents/atlas')).toBe(false);
    const held = peekHeldStepUp(heldActionId)!;
    expect(held.statement.kind).toBe('browser-profile.bind');
    // The agent chose its name, so the sentence also names its real folder.
    expect(held.reason).toContain('/agents/atlas');
    const result = await takeHeldStepUp(heldActionId)!.commit(CONFIRMING);
    expect(result.status).toBe(200);
    expect(t.profiles.isBound(profile.id, 'atlas', '/agents/atlas')).toBe(true);
  });

  it('refuses at commit time when the agent moved after the person was asked', async () => {
    const profile = t.profiles.create('Work');
    agents.moved = { name: 'Moved', projectPath: '/agents/before' };
    const res = await t.post(`/profiles/${profile.id}/agents`, { agentId: 'moved' });
    const { heldActionId } = (await res.json()) as { heldActionId: string };
    agents.moved = { name: 'Moved', projectPath: '/agents/after' };
    const result = await takeHeldStepUp(heldActionId)!.commit(CONFIRMING);
    delete agents.moved;
    expect(result.status).toBe(404);
    expect(t.profiles.isBound(profile.id, 'moved', '/agents/after')).toBe(false);
  });

  it('re-checks the agent at commit time', async () => {
    const profile = t.profiles.create('Work');
    agents.gone = { name: 'Gone', projectPath: '/agents/gone' };
    const res = await t.post(`/profiles/${profile.id}/agents`, { agentId: 'gone' });
    const { heldActionId } = (await res.json()) as { heldActionId: string };
    delete agents.gone;
    const result = await takeHeldStepUp(heldActionId)!.commit(CONFIRMING);
    expect(result.status).toBe(404);
    expect(t.profiles.isBound(profile.id, 'gone', '/agents/gone')).toBe(false);
  });

  it('refuses an unknown profile or agent without holding anything', async () => {
    const profile = t.profiles.create('Work');
    expect(
      (await t.post('/profiles/00000000-0000-4000-8000-000000000000/agents', { agentId: 'atlas' }))
        .status
    ).toBe(404);
    expect((await t.post(`/profiles/${profile.id}/agents`, { agentId: 'nobody' })).status).toBe(
      404
    );
  });

  it('removes an agent with no step-up', async () => {
    const profile = t.profiles.create('Work');
    t.profiles.bind(profile.id, 'atlas', '/agents/atlas');
    const res = await t.app.request(`/profiles/${profile.id}/agents/atlas?sessionId=chat-atlas`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(t.profiles.isBound(profile.id, 'atlas', '/agents/atlas')).toBe(false);
  });

  it('refuses to create a profile, for everyone, and stores nothing (DOR-4105)', async () => {
    const before = t.profiles.list().length;
    const res = await t.post('/profiles', { label: 'Work' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'profiles_closed' });
    expect(t.profiles.list()).toHaveLength(before);
  });
});

it('refuses sharing without a chat selector; unshare explicitly names the profile and agent', async () => {
  const t = setup();
  const profile = t.profiles.create('Example');
  const response = await t.app.request(`/profiles/${profile.id}/agents`, {
    method: 'POST',
    body: JSON.stringify({ agentId: 'atlas' }),
  });
  expect(response.status).toBe(403);
  t.profiles.bind(profile.id, 'atlas', '/agents/atlas');
  const unshare = await t.app.request(`/profiles/${profile.id}/agents/atlas`, { method: 'DELETE' });
  expect(unshare.status).toBe(200);
  expect(t.profiles.isBound(profile.id, 'atlas', '/agents/atlas')).toBe(false);
});

it('with two real agent pages open, sharing for chat A binds only agent A', async () => {
  const f = await profileLeaseFixture();
  try {
    await f.personOpen('atlas');
    await f.personOpen('bolt');
    const mayShare = createBrowserSharePolicy({
      state: (id) => f.service.personState(id),
      agentForSession: async (id) => f.facts.get(id)?.agentPath.split('/').at(-1),
      resolveSessionRuntime: async (id) => ({ type: 'test', bound: f.facts.has(id) }),
      outsideTurn: async () => null,
      runtime: () => ({ getLockInfo: () => null }),
    });
    const t = setup({
      profiles: f.profiles,
      mayShare,
      agent: (id) =>
        ['atlas', 'bolt'].includes(id) ? { name: id, projectPath: `/agents/${id}` } : undefined,
    });
    const post = (agentId: string) =>
      t.app.request('/profiles/default/agents?sessionId=atlas', {
        method: 'POST',
        body: JSON.stringify({ agentId }),
      });
    expect((await post('bolt')).status).toBe(403);
    const response = await post('atlas');
    expect(response.status).toBe(428);
    const { heldActionId } = (await response.json()) as { heldActionId: string };
    expect((await takeHeldStepUp(heldActionId)!.commit(CONFIRMING)).status).toBe(200);
    expect(f.profiles.get('default')?.agentIds).toEqual(['atlas']);
  } finally {
    await f.cleanup();
  }
});

it.each(['stranger_chat', 'read_outside_text'] as const)(
  'unshares a %s marked chat and revokes its captured lease synchronously',
  async (marked) => {
    const f = await profileLeaseFixture();
    try {
      await f.personOpen('atlas');
      f.profiles.bind('default', 'atlas', '/agents/atlas');
      await f.personOpen('atlas', 'default');
      const lease = f.service.leaseFor('atlas');
      const mayShare = vi.fn(
        createBrowserSharePolicy({
          state: (id) => f.service.personState(id),
          agentForSession: async () => 'atlas',
          resolveSessionRuntime: async () => ({ type: 'test', bound: true }),
          outsideTurn: async () => marked,
          runtime: () => ({ getLockInfo: () => ({ clientId: 'agent', acquiredAt: 1 }) }),
        })
      );
      expect(await mayShare('atlas', 'atlas')).toBe(false);
      mayShare.mockClear();
      const t = setup({ profiles: f.profiles, mayShare });
      const response = await t.app.request('/profiles/default/agents/atlas?sessionId=atlas', {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      expect(mayShare).not.toHaveBeenCalled();
      expect(f.profiles.isBound('default', 'atlas', '/agents/atlas')).toBe(false);
      expect(() => lease.assertCurrent()).toThrow();
    } finally {
      await f.cleanup();
    }
  }
);

/** Adding an agent to a browser profile waits on a person, and changes nothing until then. */
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb } from '@dorkos/test-utils/db';
import { createLocalBrowserProfileStore } from '../../services/session/local-browser/profile-store.js';
import { peekHeldStepUp, takeHeldStepUp } from '../../services/core/auth/step-up/step-up-holds.js';
import { mountLocalBrowserProfileRoutes } from '../local-browser-profiles.js';
import type { ApiEnv } from '../../http/api-chain.js';

vi.mock('../../http/request-body.js', () => ({
  readJsonBody: (c: { get(key: string): unknown }) => c.get('body' as never),
}));
vi.mock('../../http/request-facts.js', () => ({
  honoRequestFacts: () => ({ user: { sessionId: 'sess-a' } }),
}));

const agents: Record<string, { name: string; projectPath: string }> = {
  atlas: { name: 'Atlas', projectPath: '/agents/atlas' },
};

function setup() {
  const key = randomBytes(32);
  const profiles = createLocalBrowserProfileStore(createTestDb(), () => key);
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'DELETE')
      c.set('body' as never, (await c.req.json()) as never);
    await next();
  });
  mountLocalBrowserProfileRoutes(app, { profiles, agent: (id) => agents[id] });
  const post = (url: string, body: unknown) =>
    app.request(url, { method: 'POST', body: JSON.stringify(body) });
  return { profiles, app, post };
}

describe('browser profile routes', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
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
    const result = await takeHeldStepUp(heldActionId)!.commit();
    expect(result.status).toBe(200);
    expect(t.profiles.isBound(profile.id, 'atlas', '/agents/atlas')).toBe(true);
  });

  it('refuses at commit time when the agent moved after the person was asked', async () => {
    const profile = t.profiles.create('Work');
    agents.moved = { name: 'Moved', projectPath: '/agents/before' };
    const res = await t.post(`/profiles/${profile.id}/agents`, { agentId: 'moved' });
    const { heldActionId } = (await res.json()) as { heldActionId: string };
    agents.moved = { name: 'Moved', projectPath: '/agents/after' };
    const result = await takeHeldStepUp(heldActionId)!.commit();
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
    const result = await takeHeldStepUp(heldActionId)!.commit();
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
    const res = await t.app.request(`/profiles/${profile.id}/agents/atlas`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(t.profiles.isBound(profile.id, 'atlas', '/agents/atlas')).toBe(false);
  });

  it('creates a profile with no agents', async () => {
    const res = await t.post('/profiles', { label: 'Work' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { agentIds: string[] }).agentIds).toEqual([]);
  });
});

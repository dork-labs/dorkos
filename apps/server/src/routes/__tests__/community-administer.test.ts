import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ApiEnv } from '../../http/api-chain.js';
import { RemoteConnectionNotFoundError } from '../../services/communities/remote/connection-store.js';
import { addAdministerRoutes, type AdministerState } from '../community-administer.js';

const REF = 'remote_0123456789abcdef0123456789abcdef';

/** The router with a stand-in owner check: `agent` is refused as `resolveCommunityOwner` does. */
function router(state: AdministerState['state']) {
  const app = new Hono<ApiEnv>();
  addAdministerRoutes(
    app,
    (c) =>
      c.req.header('x-dorkos-agent')
        ? c.json({ error: 'An agent cannot manage space connections.' }, 403)
        : 'owner-a',
    () => ({ state })
  );
  return app;
}

describe('GET /:ref/administer', () => {
  it('answers the owner with the two flags and nothing else', async () => {
    const state = vi.fn(async () => ({ canAdminister: false, administerAvailable: true }));
    const response = await router(state).request(`/${REF}/administer`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ canAdminister: false, administerAvailable: true });
    expect(state).toHaveBeenCalledWith(REF, 'owner-a');
  });

  it('refuses an agent before reading anything', async () => {
    // Purpose: fails if an agent's request reaches the manage credentials at all (rule 3).
    const state = vi.fn();
    const response = await router(state).request(`/${REF}/administer`, {
      headers: { 'x-dorkos-agent': 'agent-1' },
    });
    expect(response.status).toBe(403);
    expect(state).not.toHaveBeenCalled();
  });

  it('answers 404 for a bad ref or another owner’s connection', async () => {
    const state = vi.fn(async () => {
      throw new RemoteConnectionNotFoundError();
    });
    expect((await router(state).request('/not-a-ref/administer')).status).toBe(404);
    expect((await router(state).request(`/${REF}/administer`)).status).toBe(404);
  });
});

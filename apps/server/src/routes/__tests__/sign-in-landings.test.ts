/**
 * What the app's sign-in landing page reads: a record, and Try again.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createSignInLandingRoutes } from '../sign-in-landings.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { SignInLandingStore } from '../../services/core/sign-in-landing/sign-in-landings.js';

// The `/api` chain reads config (login, the host allowlist); nothing is set.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

const fixtureTarget = swappableServer();

function serve(store: SignInLandingStore) {
  return fixtureTarget.mount(
    honoGroupListener({ path: '/api/sign-in-landings', routes: createSignInLandingRoutes(store) })
  );
}

describe('/api/sign-in-landings', () => {
  it('answers a record as the server wrote it, uncached', async () => {
    const store = new SignInLandingStore();
    const id = store.record({ service: 'mcp', serviceName: 'Linear', connected: true });
    const res = await request(serve(store)).get(`/api/sign-in-landings/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ id, serviceName: 'Linear', status: 'connected' });
  });

  it('answers 404 for a record it does not hold', async () => {
    const res = await request(serve(new SignInLandingStore())).get('/api/sign-in-landings/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SIGNIN_LANDING_GONE');
  });

  it('restarts a failed sign-in through its retry', async () => {
    const store = new SignInLandingStore();
    const retry = vi.fn(async () => ({
      kind: 'authorize' as const,
      authorizeUrl: 'https://auth.test/again',
    }));
    const id = store.record({ service: 'mcp', serviceName: 'Linear', connected: false, retry });
    const res = await request(serve(store)).post(`/api/sign-in-landings/${id}/retry`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'authorize', authorizeUrl: 'https://auth.test/again' });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('refuses Try again on a sign-in that cannot start again', async () => {
    const store = new SignInLandingStore();
    const id = store.record({ service: 'mcp', serviceName: 'Linear', connected: false });
    const res = await request(serve(store)).post(`/api/sign-in-landings/${id}/retry`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SIGNIN_NO_RETRY');
  });

  it('answers a failed restart with a fixed sentence, never the cause', async () => {
    const store = new SignInLandingStore();
    const id = store.record({
      service: 'mcp',
      serviceName: 'Linear',
      connected: false,
      retry: async () => {
        throw new Error('<b>raw upstream detail</b>');
      },
    });
    const res = await request(serve(store)).post(`/api/sign-in-landings/${id}/retry`).send({});
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: 'Couldn’t start the sign-in again.',
      code: 'SIGNIN_RETRY_FAILED',
    });
  });
});

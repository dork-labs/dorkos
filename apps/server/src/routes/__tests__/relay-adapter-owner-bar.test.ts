/**
 * DOR-3271 (Security Must): confirming a paused connection, and writing an
 * `env:`/`keychain:` reference, are the owner's alone. With login on, a
 * signed-in person who does not own this install gets a 403 on both confirm
 * routes, and writes a connection's settings as anyone else does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const authority = vi.hoisted(() => ({
  refusal: undefined as undefined | 'not-a-person' | 'not-the-owner',
}));
vi.mock('../../lib/caller-authority.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/caller-authority.js')>()),
  refuseUnlessAccountOwner: () => authority.refusal,
}));

import type { ApiEnv } from '../../http/api-chain.js';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';
import { registerConfirmReferencesRoute, secretWriter } from '../relay-adapter-http.js';

function app() {
  const confirmReferences = vi.fn(async () => {});
  const router = new Hono<ApiEnv>();
  // What the body parser in the real chain sets.
  router.use(async (c, next) => {
    if (c.req.method === 'POST') c.set('body', await c.req.json());
    await next();
  });
  registerConfirmReferencesRoute(router, { confirmReferences } as unknown as AdapterManager);
  router.get('/writer', (c) => c.json({ writer: secretWriter(c) }));
  return { router, confirmReferences };
}

/** The raw Node request the facts are read from: loopback, no agent header. */
const NODE = { incoming: { headers: {}, socket: { remoteAddress: '127.0.0.1' } } };

const confirm = (router: Hono<ApiEnv>, method: 'POST' | 'DELETE') =>
  router.request(
    '/adapters/wh/confirm-references',
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ fingerprint: 'fp' }) } : {}),
    },
    NODE
  );

beforeEach(() => {
  authority.refusal = undefined;
});

describe('the owner bar on a connection’s secrets', () => {
  it('refuses a signed-in non-owner on both confirm routes, and records nothing', async () => {
    authority.refusal = 'not-the-owner';
    const { router, confirmReferences } = app();
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await confirm(router, method);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'Only the owner of this DorkOS can confirm this setting.',
        code: 'owner_only',
      });
    }
    expect(confirmReferences).not.toHaveBeenCalled();
  });

  it('refuses an agent as person_only', async () => {
    authority.refusal = 'not-a-person';
    const { router } = app();
    const res = await confirm(router, 'POST');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('person_only');
  });

  it('lets the owner confirm and undo', async () => {
    const { router, confirmReferences } = app();
    expect((await confirm(router, 'POST')).status).toBe(200);
    expect((await confirm(router, 'DELETE')).status).toBe(200);
    expect(confirmReferences).toHaveBeenNthCalledWith(1, 'wh', 'fp', false);
    expect(confirmReferences).toHaveBeenNthCalledWith(2, 'wh', null, true);
  });

  it('writes a signed-in non-owner’s secret fields as anyone else’s, never as the owner', async () => {
    const { router } = app();
    authority.refusal = 'not-the-owner';
    expect(await (await router.request('/writer', {}, NODE)).json()).toEqual({ writer: 'agent' });
    authority.refusal = undefined;
    expect(await (await router.request('/writer', {}, NODE)).json()).toEqual({ writer: 'person' });
  });
});

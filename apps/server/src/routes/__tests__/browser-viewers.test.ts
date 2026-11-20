import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiEnv } from '../../http/api-chain.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { BrowserViewerRegistry } from '../../services/session/browser-viewers/viewer-registry.js';
import { createBrowserViewerRoutes } from '../browser-viewers.js';
import { setTestOwner } from './test-owner.js';

beforeAll(() => setTestOwner('viewer-owner'));

function fixture() {
  const resolve = vi.fn(async () => {
    throw Error('no-page');
  });
  const registry = new BrowserViewerRegistry(resolve);
  let user: RequestUser | undefined = {
    userId: 'viewer-owner',
    credential: 'cookie',
    sessionId: 'signed-in-session',
  };
  let enabled = true;
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    if (c.req.method === 'POST') c.set('body', await c.req.json());
    return next();
  });
  app.route(
    '/api/browser-viewers',
    createBrowserViewerRoutes(registry, () => enabled)
  );
  const call = (
    method: string,
    suffix: string,
    headers: Record<string, string> = {},
    body: object = {}
  ) => {
    const allHeaders = {
      host: 'localhost',
      'x-client-id': 'owner-window',
      'content-type': 'application/json',
      ...headers,
    };
    const incoming = { headers: allHeaders, socket: { remoteAddress: '127.0.0.1' } };
    return app.request(
      `http://localhost/api/browser-viewers${suffix}`,
      {
        method,
        headers: allHeaders,
        ...(method === 'POST' || method === 'DELETE' ? { body: JSON.stringify(body) } : {}),
      },
      { incoming } as unknown as ApiEnv['Bindings']
    );
  };
  return {
    call,
    resolve,
    registry,
    setUser: (next: typeof user) => {
      user = next;
    },
    disable: () => {
      enabled = false;
    },
  };
}

const routes = [
  ['POST', ''],
  ['POST', '/viewer/frame'],
  ['DELETE', '/viewer'],
] as const;

describe('owner-only watch routes', () => {
  it.each(routes)('refuses a missing session on %s %s', async (method, suffix) => {
    const f = fixture();
    f.setUser(undefined);
    const response = await f.call(method, suffix);
    expect(response.status).toBe(403);
    expect(f.resolve).not.toHaveBeenCalled();
    expect((await response.json()).code).toBe('viewer_person_only');
    await f.registry.close();
  });

  it.each(
    routes.flatMap(([method, suffix]) =>
      [
        'x-dorkos-agent',
        'authorization',
        'x-api-key',
        'proxy-authorization',
        'x-dorkos-approval',
      ].map((header) => [method, suffix, header])
    )
  )('refuses program credentials beside the cookie: %s %s %s', async (method, suffix, header) => {
    const f = fixture();
    const response = await f.call(method!, suffix!, { [header!]: 'not-a-person' });
    expect(response.status).toBe(403);
    expect(f.resolve).not.toHaveBeenCalled();
    await f.registry.close();
  });

  it('does not turn an agent-selected tab or profile into authorization', async () => {
    const f = fixture();
    const response = await f.call('POST', '', {}, { chatId: 'chat-a', tabId: 'tab-b' });
    expect(response.status).toBe(400);
    expect(f.resolve).not.toHaveBeenCalled();
    await f.registry.close();
  });

  it('reaches only the selected chat resolver for a proven owner', async () => {
    const f = fixture();
    const response = await f.call('POST', '', {}, { chatId: 'chat-a' });
    expect(response.status).toBe(409);
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(
      'chat-a',
      { ownerId: 'viewer-owner', sessionId: 'signed-in-session', clientId: 'owner-window' },
      expect.stringMatching(/^[\w-]{43}$/)
    );
    expect(await response.text()).not.toContain('no-page');
    expect(response.headers.get('cache-control')).toContain('no-store');
    await f.registry.close();
  });

  it('keeps the feature off without touching the page resolver', async () => {
    const f = fixture();
    f.disable();
    expect((await f.call('POST', '', {}, { chatId: 'chat-a' })).status).toBe(404);
    expect(f.resolve).not.toHaveBeenCalled();
    await f.registry.close();
  });
});

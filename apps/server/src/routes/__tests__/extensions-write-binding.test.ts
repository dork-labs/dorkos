/**
 * An extension's data, secrets and settings can only be written for that
 * extension, and only by a person or an agent (DOR-3066).
 *
 * The routes are exercised through the real `/api` chain. Login is off there,
 * as on a fresh install; the login-on bar is exercised on the binding itself,
 * with the session the chain would have resolved set the same way.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const secretStore = new Map<string, string>();

vi.mock('@dorkos/shared/extension-secrets', () => ({
  ExtensionSecretStore: vi.fn().mockImplementation(function () {
    return {
      get: vi.fn(async (key: string) => secretStore.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        secretStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        secretStore.delete(key);
      }),
      has: vi.fn(async (key: string) => secretStore.has(key)),
    };
  }),
}));

const writeFile = vi.fn().mockResolvedValue(undefined);
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: (...args: unknown[]) => writeFile(...args),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { RequestFactsEnv } from '../../http/request-facts.js';
import { createExtensionsRoutes } from '../extensions.js';
import { EXTENSION_WRITE_REFUSED, refusedExtensionWrite } from '../extension-write-binding.js';

const target = swappableServer();

/** An extension that declares one secret and one setting. */
function record(id: string): ExtensionRecord {
  return {
    id,
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      serverCapabilities: { secrets: [{ key: 'api_key', label: 'API key' }] },
      settings: [{ key: 'colour', label: 'Colour', type: 'text' }],
    },
    status: 'compiled',
    scope: 'global',
    path: `/tmp/extensions/${id}`,
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
  } as unknown as ExtensionRecord;
}

/** The real routes over two installed extensions. */
function routesApp() {
  const manager = {
    get: vi.fn((id: string) => (id === 'alpha' || id === 'beta' ? record(id) : undefined)),
    listPublic: vi.fn().mockReturnValue([]),
    listShadowedPublic: vi.fn().mockReturnValue([]),
  };
  return honoGroupListener({
    path: '/api/extensions',
    routes: createExtensionsRoutes({
      manager: manager as unknown as Parameters<typeof createExtensionsRoutes>[0]['manager'],
      dorkHome: '/tmp/dork-test',
      getCwd: () => '/tmp/project',
    }),
  });
}

describe('the extension write routes, bound to the caller', () => {
  beforeEach(() => {
    secretStore.clear();
    writeFile.mockClear();
    target.mount(routesApp());
  });

  it('lets an extension write its own secret', async () => {
    const as = { 'X-DorkOS-Extension': 'alpha' };
    expect(
      (
        await request(target.server)
          .put('/api/extensions/alpha/secrets/api_key')
          .set(as)
          .send({ value: 'k' })
      ).status
    ).toBe(200);
    expect(secretStore.get('api_key')).toBe('k');
  });

  it.each([
    ['PUT', '/api/extensions/beta/data', { n: 1 }],
    ['PUT', '/api/extensions/beta/secrets/api_key', { value: 'stolen' }],
    ['DELETE', '/api/extensions/beta/secrets/api_key', undefined],
    ['PUT', '/api/extensions/beta/settings/colour', { value: 'red' }],
    ['DELETE', '/api/extensions/beta/settings/colour', undefined],
  ] as const)(
    'refuses %s %s from a different extension, and changes nothing',
    async (method, url, body) => {
      secretStore.set('api_key', 'original');
      const call =
        method === 'PUT'
          ? request(target.server).put(url).set({ 'X-DorkOS-Extension': 'alpha' }).send(body)
          : request(target.server).delete(url).set({ 'X-DorkOS-Extension': 'alpha' });
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(EXTENSION_WRITE_REFUSED);
      expect(secretStore.get('api_key')).toBe('original');
      expect(writeFile).not.toHaveBeenCalled();
    }
  );

  it('lets the host write with no stamp while login is off (DOR-505)', async () => {
    const res = await request(target.server)
      .put('/api/extensions/beta/secrets/api_key')
      .send({ value: 'from-settings' });
    expect(res.status).toBe(200);
    expect(secretStore.get('api_key')).toBe('from-settings');
  });
});

describe('the binding with login on', () => {
  /** A one-route app whose caller is set the way the session gate would. */
  function bindingApp(caller: {
    user?: { userId: string; credential: 'cookie' | 'api-key' };
    agent?: boolean;
  }) {
    const routes = new Hono<RequestFactsEnv>().put('/:id', (c) => {
      return refusedExtensionWrite(c, c.req.param('id'), () => true) ?? c.json({ ok: true });
    });
    return honoGroupListener(
      { path: '/api/bind', routes },
      {
        before: async (c, next) => {
          if (caller.user) c.set('user', caller.user);
          if (caller.agent) {
            c.set('agentIdentity', {
              agentPath: '/agents/a',
              displayName: 'A',
              createdAt: new Date().toISOString(),
            });
          }
          await next();
        },
      }
    );
  }

  it('refuses a key-only caller, stamp or no stamp', async () => {
    target.mount(bindingApp({ user: { userId: 'u', credential: 'api-key' } }));
    expect((await request(target.server).put('/api/bind/alpha').send({})).status).toBe(403);
    expect(
      (
        await request(target.server)
          .put('/api/bind/alpha')
          .set({ 'X-DorkOS-Extension': 'alpha' })
          .send({})
      ).status
    ).toBe(403);
  });

  it('lets a person with a session cookie write, with or without a stamp', async () => {
    target.mount(bindingApp({ user: { userId: 'u', credential: 'cookie' } }));
    expect((await request(target.server).put('/api/bind/alpha').send({})).status).toBe(200);
    expect(
      (
        await request(target.server)
          .put('/api/bind/alpha')
          .set({ 'X-DorkOS-Extension': 'alpha' })
          .send({})
      ).status
    ).toBe(200);
  });

  it('lets an agent that identifies itself write (DOR-1801)', async () => {
    target.mount(bindingApp({ user: { userId: 'u', credential: 'api-key' }, agent: true }));
    expect((await request(target.server).put('/api/bind/alpha').send({})).status).toBe(200);
  });

  it('still refuses a person’s page writing for another extension', async () => {
    target.mount(bindingApp({ user: { userId: 'u', credential: 'cookie' } }));
    const res = await request(target.server)
      .put('/api/bind/beta')
      .set({ 'X-DorkOS-Extension': 'alpha' })
      .send({});
    expect(res.status).toBe(403);
  });
});

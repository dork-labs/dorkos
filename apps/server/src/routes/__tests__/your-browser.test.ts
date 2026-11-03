/** The real API chain must refuse programs before any profile metadata is read. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

const gate = vi.hoisted(() => ({ login: true, owner: true }));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: gate.login } : undefined),
    onChange: () => () => {},
  },
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => (gate.owner ? { id: 'user_owner', name: 'Owner' } : null),
}));

import { createYourBrowserRoutes } from '../your-browser.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { markIngress, type IngressKind } from '../../services/core/remote/ingress-mark.js';

const scan = vi.fn(async () => ({
  supported: true,
  profiles: [
    {
      browser: 'chrome' as const,
      directory: 'Default',
      displayName: 'Work',
      email: 'work@example.test',
    },
  ],
  unreadable: [],
}));
let user: RequestUser | undefined;
let ingress: IngressKind | undefined;
const listener = honoGroupListener(
  { path: '/api/your-browser', routes: createYourBrowserRoutes(scan) },
  {
    before: async (c, next) => {
      if (user) c.set('user', user);
      await next();
    },
  }
);
const server = listeningServer((incoming, response) => {
  if (ingress) markIngress(incoming, ingress);
  listener(incoming, response);
});
beforeEach(() => {
  vi.clearAllMocks();
  gate.login = true;
  gate.owner = true;
  ingress = undefined;
  user = { userId: 'user_owner', credential: 'cookie' };
});

describe('Your browser metadata route', () => {
  it('reads on a person POST only and forbids caching', async () => {
    expect(scan).not.toHaveBeenCalled();
    const result = await request(server)
      .post('/api/your-browser/scan')
      .set('Host', 'localhost')
      .send({});
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.profiles[0].email).toBe('work@example.test');
    expect(scan).toHaveBeenCalledOnce();
  });

  it.each(['agent', 'bearer', 'api-key', 'approval', 'other-person', 'no-session'] as const)(
    'refuses %s before scanning',
    async (caller) => {
      const call = request(server).post('/api/your-browser/scan').set('Host', 'localhost');
      if (caller === 'agent') call.set('X-DorkOS-Agent', '');
      if (caller === 'bearer') call.set('Authorization', 'Bearer not-a-person');
      if (caller === 'api-key') user = { userId: 'user_owner', credential: 'api-key' };
      if (caller === 'approval') call.set('X-DorkOS-Approval', 'not-a-person');
      if (caller === 'other-person') user = { userId: 'user_guest', credential: 'cookie' };
      if (caller === 'no-session') user = undefined;
      const result = await call.send({});
      expect(result.status).toBe(403);
      expect(scan).not.toHaveBeenCalled();
      expect(JSON.stringify(result.body)).not.toContain('work@example.test');
    }
  );

  it.each(['login-off', 'ownerless'] as const)(
    'refuses a caller without a person session with %s',
    async (posture) => {
      gate.login = false;
      gate.owner = posture !== 'ownerless';
      user = undefined;
      const response = await request(server)
        .post('/api/your-browser/scan')
        .set('Host', 'localhost')
        .send({});
      expect(response.status).toBe(403);
      expect(scan).not.toHaveBeenCalled();
    }
  );

  it('still requires and accepts the owner session with Require login off', async () => {
    gate.login = false;
    const response = await request(server)
      .post('/api/your-browser/scan')
      .set('Host', 'localhost')
      .send({});
    expect(response.status).toBe(200);
    expect(scan).toHaveBeenCalledOnce();
  });

  it('refuses extension page code before scanning', async () => {
    const response = await request(server)
      .post('/api/your-browser/scan')
      .set('Host', 'localhost')
      .set('Origin', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      .send({});
    expect(response.status).toBe(403);
    expect(scan).not.toHaveBeenCalled();
  });

  it.each(['wifi', 'relay'] as const)(
    'refuses an owner on the unencrypted %s ingress',
    async (kind) => {
      ingress = kind;
      const response = await request(server)
        .post('/api/your-browser/scan')
        .set('Host', 'localhost')
        .send({});
      expect(response.status).toBe(403);
      expect(scan).not.toHaveBeenCalled();
    }
  );

  it('accepts the signed-in owner over managed encrypted access, per the shared person bar', async () => {
    ingress = 'managed';
    const response = await request(server)
      .post('/api/your-browser/scan')
      .set('Host', 'localhost')
      .send({});
    expect(response.status).toBe(200);
    expect(scan).toHaveBeenCalledOnce();
  });

  it('does not scan through GET or accept client-chosen paths', async () => {
    expect(
      (await request(server).get('/api/your-browser/scan').set('Host', 'localhost')).status
    ).toBe(404);
    expect(scan).not.toHaveBeenCalled();
    await request(server)
      .post('/api/your-browser/scan')
      .set('Host', 'localhost')
      .send({ path: '/private/Cookies' });
    // The route hands no request data to the scanner; it only knows fixed paths.
    expect(scan).toHaveBeenCalledWith();
  });
});

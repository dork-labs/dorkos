/** The real API chain must refuse programs before any profile metadata is read. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: true } : undefined),
    onChange: () => () => {},
  },
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'user_owner', name: 'Owner' }),
}));

import { createYourBrowserRoutes } from '../your-browser.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';

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
const server = listeningServer(
  honoGroupListener(
    { path: '/api/your-browser', routes: createYourBrowserRoutes(scan) },
    {
      before: async (c, next) => {
        if (user) c.set('user', user);
        await next();
      },
    }
  )
);
beforeEach(() => {
  vi.clearAllMocks();
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

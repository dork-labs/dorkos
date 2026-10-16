/**
 * A hub is never linked to an account (DOR-2935): its key comes from its
 * environment and is its own, so the link, relink and unlink writes refuse
 * there, before reaching the link manager. The reads and the link check stay
 * open. On a person's own computer the writes still reach it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
vi.mock('../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
// The front door is not what this file is about: it admits everything here.
vi.mock('../../services/core/hub/hub-serving.js', () => ({
  admitHubRequest: () => null,
  trackHubConnection: () => {},
}));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
const manager = vi.hoisted(() => ({
  startLink: vi.fn(async () => ({})),
  getStatus: vi.fn(() => ({ state: 'idle' })),
  unlink: vi.fn(async () => undefined),
  cancelLink: vi.fn(async () => ({ state: 'idle' })),
  getSummary: vi.fn(() => ({ linked: false, accountLabel: null, lastHeartbeatAt: null })),
  checkLink: vi.fn(async () => ({ linked: false, accountLabel: null, lastHeartbeatAt: null })),
}));
vi.mock('../../services/core/auth/cloud-link.js', () => ({
  getCloudLinkManager: () => manager,
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => undefined, onChange: () => () => {} },
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'user_owner', name: 'Owner' }),
}));

import cloudRouter from '../cloud.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';

const server = listeningServer(
  honoGroupListener(
    { path: '/api/cloud', routes: cloudRouter },
    {
      before: async (c, next) => {
        c.set('user', { userId: 'user_owner', credential: 'cookie' });
        await next();
      },
    }
  )
);

const WRITES = [
  ['/api/cloud/link/start', manager.startLink],
  ['/api/cloud/link/cancel', manager.cancelLink],
  ['/api/cloud/unlink', manager.unlink],
] as const;

beforeEach(() => {
  role.value = 'hub';
  vi.clearAllMocks();
});

describe('linking on a hub', () => {
  it.each(WRITES)('refuses %s before it reaches the link manager', async (path, effect) => {
    const res = await request(server).post(path).set('Host', 'localhost:4242');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HUB_LINKED_BY_CLOUD');
    expect(effect).not.toHaveBeenCalled();
  });

  it('keeps the reads and the link check open', async () => {
    for (const path of ['/api/cloud/link/status', '/api/cloud/status']) {
      const res = await request(server).get(path).set('Host', 'localhost:4242');
      expect(res.status, path).toBe(200);
    }
    const check = await request(server).post('/api/cloud/link/check').set('Host', 'localhost:4242');
    expect(check.status).toBe(200);
    expect(manager.checkLink).toHaveBeenCalledTimes(1);
  });

  it.each(WRITES)(
    'still reaches the link manager for %s on a person`s own computer',
    async (path, effect) => {
      role.value = 'computer';
      await request(server).post(path).set('Host', 'localhost:4242');
      expect(effect).toHaveBeenCalledTimes(1);
    }
  );
});

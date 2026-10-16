/**
 * A hub is linked by DorkOS Cloud when it boots (DOR-2935): its key comes
 * from its environment, so the link, relink and unlink writes refuse there,
 * before reaching the link manager. On a person's own computer they still
 * reach it.
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
  getSummary: vi.fn(() => ({ linked: true, accountLabel: null, lastHeartbeatAt: null })),
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

  it('keeps the reads open', async () => {
    const res = await request(server).get('/api/cloud/link/status').set('Host', 'localhost:4242');
    expect(res.status).toBe(200);
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

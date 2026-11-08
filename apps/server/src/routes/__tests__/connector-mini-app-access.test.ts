/**
 * `/api/connectors/mini-app-access` (DOR-3547): only the owner at the app lists
 * or revokes a mini app's access to a connected app, and there is no route
 * here that gives one. Driven through the real `/api` chain.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { initConfigManager } from '../../services/core/config-manager.js';
import { createConnectorMiniAppAccessRoutes } from '../connector-mini-app-access.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { MiniAppAccess } from '../../services/connectors/extensions/mini-app-access.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const target = swappableServer();
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-mini-app-access-'));
beforeAll(() => {
  initConfigManager(configDir);
});
afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('mini app access routes', () => {
  const access = { list: vi.fn(), revoke: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    access.list.mockReturnValue({ waiting: [], allowed: [] });
    access.revoke.mockReturnValue(true);
    target.mount(
      honoGroupListener({
        path: '/api/connectors',
        routes: createConnectorMiniAppAccessRoutes({
          access: () => access as unknown as MiniAppAccess,
          resolveOwner: () => OWNER,
          loginEnabled: () => false,
          trustedOrigins: () => ['http://localhost:4242'],
        }),
      })
    );
  });

  it('lists for the owner at the app', async () => {
    const res = await request(target.server).get('/api/connectors/mini-app-access');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ waiting: [], allowed: [] });
  });

  it('revokes for the owner, and says when nothing was live', async () => {
    const ok = await request(target.server)
      .post('/api/connectors/mini-app-access/approval-a/revoke')
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'revoked', approvalId: 'approval-a' });
    expect(access.revoke).toHaveBeenCalledWith('approval-a');
    access.revoke.mockReturnValue(false);
    const gone = await request(target.server)
      .post('/api/connectors/mini-app-access/approval-a/revoke')
      .send({});
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('MINI_APP_ACCESS_NOT_FOUND');
  });

  it.each([
    ['an agent', { 'x-dorkos-agent': 'agent-a' }],
    ['a program', { authorization: 'Bearer key-a' }],
    ['another site', { origin: 'https://elsewhere.example' }],
  ])('refuses %s, and revokes nothing', async (_who, headers) => {
    const list = await request(target.server).get('/api/connectors/mini-app-access').set(headers);
    const revoke = await request(target.server)
      .post('/api/connectors/mini-app-access/approval-a/revoke')
      .set(headers)
      .send({});
    expect([list.status, revoke.status]).not.toContain(200);
    expect(access.list).not.toHaveBeenCalled();
    expect(access.revoke).not.toHaveBeenCalled();
  });

  it('has no route that gives a yes', async () => {
    for (const p of ['/api/connectors/mini-app-access', '/api/connectors/mini-app-access/x']) {
      const res = await request(target.server).post(p).send({ decision: 'approve' });
      expect(res.status).toBe(404);
    }
  });
});

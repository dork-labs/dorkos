/**
 * The management doors on the capability mount answer a service's refusal as
 * their hand routes did (DOR-4978): the same status, code and sentence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { initConfigManager } from '../../services/core/config-manager.js';
import { ManagedConnectorCloudError } from '../../services/core/auth/cloud-link-client.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createConnectorManagementRoutes } from '../connector-management.js';
import { withOwnerDoors } from './connector-owner-doors.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const fixtureTarget = swappableServer();

// The `/api` chain reads the login setting from a real config store: off.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-connector-owner-doors-'));
beforeAll(() => initConfigManager(configDir));
afterAll(() => fs.rmSync(configDir, { recursive: true, force: true }));

describe('connection management doors on the mount', () => {
  const reconciliation = { preview: vi.fn(), apply: vi.fn(), revokeEveryAgent: vi.fn() };
  const app = honoGroupListener(
    withOwnerDoors(createConnectorManagementRoutes, {
      registry: { migrationHealth: () => ({ status: 'ready', migrated: false }) },
      reviews: {},
      reconciliation,
      exclusions: {},
      resolveOwner: () => OWNER,
      loginEnabled: () => false,
      trustedOrigins: () => ['http://localhost:4242'],
    } as unknown as Parameters<typeof createConnectorManagementRoutes>[0])
  );

  it.each([
    ['unauthorized', 401, 'cloud_link_required'],
    ['unavailable', 503, 'cloud_unavailable'],
    ['request_failed', 502, 'cloud_refused'],
  ] as const)('answers a refused cloud call (%s) as the hand route does', async (code, status) => {
    reconciliation.preview.mockRejectedValueOnce(new ManagedConnectorCloudError(code));
    reconciliation.revokeEveryAgent.mockRejectedValueOnce(new ManagedConnectorCloudError(code));
    const served = fixtureTarget.mount(app);
    const hand = await request(served)
      .post('/api/connectors/reconciliation/previews')
      .send({ connectionId: 'connection-a' })
      .expect(status);
    const door = await request(served)
      .delete('/api/connectors/connections/connection-a/every-agent')
      .expect(status);
    expect(door.body).toEqual(hand.body);
  });

  it('says agents’ requests are off, as the hand route did, while agent identity is off', async () => {
    const response = await request(fixtureTarget.mount(app))
      .get('/api/connectors/agent-requests/request-a/authentication-flows/flow-a')
      .expect(503);
    expect(response.body).toMatchObject({
      code: 'temporarily_unavailable',
      detail: 'Agents’ requests aren’t available while agent identity is off.',
    });
  });
});

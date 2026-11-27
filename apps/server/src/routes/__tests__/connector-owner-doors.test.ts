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
import { z } from 'zod';
import { ConnectorGrantExclusionError } from '../../services/connectors/access/grant-exclusions.js';
import { ConnectorAccessQueryError } from '../../services/connectors/execution/access-query-service.js';
import { ConnectorManagementReviewError } from '../../services/connectors/management-review-service.js';
import { createConnectorManagementRoutes } from '../connector-management.js';
import {
  ACCESS_QUERY_PROBLEM,
  GRANT_EXCLUSION_PROBLEM,
  MANAGEMENT_REVIEW_PROBLEM,
  connectorProblemBody,
  type ConnectorProblem,
} from '../connector-problems.js';
import { withOwnerDoors } from './connector-owner-doors.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const fixtureTarget = swappableServer();

// The `/api` chain reads the login setting from a real config store: off.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-connector-owner-doors-'));
beforeAll(() => initConfigManager(configDir));
afterAll(() => fs.rmSync(configDir, { recursive: true, force: true }));

describe('connection management doors on the mount', () => {
  const reconciliation = { preview: vi.fn(), apply: vi.fn(), revokeEveryAgent: vi.fn() };
  const reviews = { get: vi.fn() };
  const exclusions = { leaveOut: vi.fn() };
  const usage = { listOperatorUsage: vi.fn() };
  const app = honoGroupListener(
    withOwnerDoors(
      createConnectorManagementRoutes,
      {
        registry: { migrationHealth: () => ({ status: 'ready', migrated: false }) },
        reviews,
        reconciliation,
        exclusions,
        resolveOwner: () => OWNER,
        loginEnabled: () => false,
        trustedOrigins: () => ['http://localhost:4242'],
      } as unknown as Parameters<typeof createConnectorManagementRoutes>[0],
      { usage } as never
    )
  );

  it.each([
    ['unauthorized', 401, 'cloud_link_required'],
    ['unavailable', 503, 'cloud_unavailable'],
    ['request_failed', 502, 'cloud_refused'],
  ] as const)(
    'answers a refused cloud call (%s) as the hand route does',
    async (code, status, problem) => {
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
      expect(hand.body.code).toBe(problem);
      expect(door.body).toEqual(hand.body);
    }
  );

  it('says agents’ requests are off, as the hand route did, while agent identity is off', async () => {
    const response = await request(fixtureTarget.mount(app))
      .get('/api/connectors/agent-requests/request-a/authentication-flows/flow-a')
      .expect(503);
    expect(response.body).toMatchObject({
      code: 'temporarily_unavailable',
      detail: 'Agents’ requests aren’t available while agent identity is off.',
    });
  });

  // What each hand route sent for these refusals (`sendConnectorProblem`), byte for byte.
  it.each([
    [
      'a review that is gone',
      () =>
        reviews.get.mockImplementationOnce(() => {
          throw new ConnectorManagementReviewError('review_not_found', 'private words');
        }),
      'get',
      '/api/connectors/reviews/review-a',
      MANAGEMENT_REVIEW_PROBLEM.review_not_found,
    ],
    [
      'leaving out an agent that is gone',
      () =>
        exclusions.leaveOut.mockRejectedValueOnce(
          new ConnectorGrantExclusionError('agent_not_found', 'private words')
        ),
      'put',
      '/api/connectors/connections/connection-a/exclusions/agent-a',
      GRANT_EXCLUSION_PROBLEM.agent_not_found,
    ],
    [
      'a usage page link that expired',
      () =>
        usage.listOperatorUsage.mockImplementationOnce(() => {
          throw new ConnectorAccessQueryError('invalid_cursor', 'private words');
        }),
      'get',
      '/api/connectors/usage/operator?cursor=stale',
      ACCESS_QUERY_PROBLEM.invalid_cursor,
    ],
  ] as const)(
    'answers %s as its hand route did',
    async (_name, arrange, method, url, row: ConnectorProblem) => {
      arrange();
      const response = await request(fixtureTarget.mount(app))[method](url);
      const sent = connectorProblemBody(row, new Error('private words'));
      expect(response.status).toBe(sent.status);
      expect(response.body).toEqual(sent);
    }
  );

  it('answers a service’s own schema failure as a fault, never a 400 naming its fields', async () => {
    reviews.get.mockImplementationOnce(() => z.object({ internalField: z.string() }).parse({}));
    const response = await request(fixtureTarget.mount(app))
      .get('/api/connectors/reviews/review-a')
      .expect(500);
    expect(response.body.code).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toContain('internalField');
  });
});

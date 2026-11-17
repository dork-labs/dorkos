/**
 * An owner decision that gives an agent access waits for the owner to confirm
 * it's them (DOR-4355): approving a review, answering a request with access,
 * connecting an account for one, letting one back in, and a grant change that
 * may give more. Saying no, leaving one out and taking access away stay immediate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { env } from '../../env.js';
import { createConnectorManagementRoutes } from '../connector-management.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const OWNER = { kind: 'local_install', installationId: 'northwind-install' } as const;
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;
const EXCLUSIONS = '/api/connectors/connections/connection-a/exclusions/agent-a';

describe('connected-app decision confirmation', () => {
  const reviews = {
    create: vi.fn(),
    get: vi.fn(),
    getProgramStatus: vi.fn(),
    list: vi.fn(),
    resolve: vi.fn(async () => ({ review: { reviewRequestId: 'review-a' } })),
  };
  const reconciliation = {
    preview: vi.fn(),
    apply: vi.fn(async () => ({ connectionId: 'connection-a' })),
    revokeEveryAgent: vi.fn(async () => ({ connectionId: 'connection-a', revokedCount: 1 })),
  };
  const change = (excluded: boolean) => ({
    connectionId: 'connection-a',
    agentId: 'agent-a',
    excluded,
    changed: true,
  });
  const exclusions = {
    list: vi.fn(() => []),
    leaveOut: vi.fn(async () => change(true)),
    letBackIn: vi.fn(async () => change(false)),
  };
  const agentRequests = {
    listForOwner: vi.fn(),
    getForOwner: vi.fn(),
    resolve: vi.fn(async () => ({ requestId: 'request-a', status: 'resolved' })),
    startAuthentication: vi.fn(async () => ({ flowId: 'flow-a', state: 'starting' })),
    pollAuthentication: vi.fn(),
  };
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/connectors',
      routes: createConnectorManagementRoutes({
        registry: { migrationHealth: () => ({ status: 'ready', migrated: false }) },
        reviews,
        reconciliation,
        exclusions,
        agentRequests,
        resolveOwner: () => OWNER,
        loginEnabled: () => true,
        trustedOrigins: () => [ORIGIN],
      } as unknown as Parameters<typeof createConnectorManagementRoutes>[0]),
    },
  ]);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const raises: [string, 'post' | 'delete', string, object | undefined, Mock, number][] = [
    [
      'approving a review',
      'post',
      '/api/connectors/reviews/review-a/decision',
      { decision: 'approved' },
      reviews.resolve,
      200,
    ],
    [
      'answering an agent request with access',
      'post',
      '/api/connectors/agent-requests/request-a/decision',
      { decision: 'current_access', connectionId: 'connection-a' },
      agentRequests.resolve,
      200,
    ],
    [
      'connecting an account for an agent',
      'post',
      '/api/connectors/agent-requests/request-a/authentication-flows',
      { providerInstanceId: 'provider-a', label: 'Northwind mail' },
      agentRequests.startAuthentication,
      201,
    ],
    ['letting an agent back in', 'delete', EXCLUSIONS, undefined, exclusions.letBackIn, 200],
    [
      'giving an agent more actions',
      'post',
      '/api/connectors/reconciliation/apply',
      {
        previewId: 'preview-a',
        grants: [{ agentId: 'agent-a', operationRevisionIds: ['read-v1'] }],
      },
      reconciliation.apply,
      200,
    ],
    [
      'sharing with every agent',
      'post',
      '/api/connectors/reconciliation/apply',
      { previewId: 'preview-a', grants: [], everyAgent: { operationRevisionIds: ['read-v1'] } },
      reconciliation.apply,
      200,
    ],
  ];

  it.each(raises)(
    'holds %s until the owner confirms',
    async (_name, method, url, body, write, status) => {
      const ask = owner.call(method, url, 'own-tunnel');
      const held = await (body === undefined ? ask : ask.send(body));
      expect(held.status).toBe(428);
      expect(write).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
        'not-your-action'
      );
      expect(write).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
        ok: true,
        status,
      });
      expect(write).toHaveBeenCalledOnce();
    }
  );

  it('holds approving a review at this computer too', async () => {
    const held = await owner
      .call('post', '/api/connectors/reviews/review-a/decision')
      .send({ decision: 'approved' });
    expect(held.status).toBe(428);
    expect(reviews.resolve).not.toHaveBeenCalled();
  });

  it('keeps approving a review from Wi-Fi refused', async () => {
    const res = await owner
      .call('post', '/api/connectors/reviews/review-a/decision', 'wifi')
      .send({ decision: 'approved' });
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(reviews.resolve).not.toHaveBeenCalled();
  });

  const reverses: [string, 'post' | 'put' | 'delete', string, object | undefined, Mock][] = [
    [
      'denying a review',
      'post',
      '/api/connectors/reviews/review-a/decision',
      { decision: 'denied' },
      reviews.resolve,
    ],
    [
      'denying an agent request',
      'post',
      '/api/connectors/agent-requests/request-a/decision',
      { decision: 'denied' },
      agentRequests.resolve,
    ],
    ['leaving an agent out', 'put', EXCLUSIONS, undefined, exclusions.leaveOut],
    [
      'taking every action away',
      'post',
      '/api/connectors/reconciliation/apply',
      {
        previewId: 'preview-a',
        grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
        everyAgent: { operationRevisionIds: [] },
      },
      reconciliation.apply,
    ],
    [
      'stopping the every-agent share',
      'delete',
      '/api/connectors/connections/connection-a/every-agent',
      undefined,
      reconciliation.revokeEveryAgent,
    ],
  ];

  it.each(reverses)('answers %s at once', async (_name, method, url, body, write) => {
    const ask = owner.call(method, url, 'own-tunnel');
    const res = await (body === undefined ? ask : ask.send(body));
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(write).toHaveBeenCalledOnce();
  });

  it('holds a grant change that keeps a level with no actions, since it may give more', async () => {
    const held = await owner
      .call('post', '/api/connectors/reconciliation/apply', 'own-tunnel')
      .send({
        previewId: 'preview-a',
        grants: [{ agentId: 'agent-a', operationRevisionIds: [], level: 'read' }],
      });
    expect(held.status).toBe(428);
    expect(reconciliation.apply).not.toHaveBeenCalled();
  });
});

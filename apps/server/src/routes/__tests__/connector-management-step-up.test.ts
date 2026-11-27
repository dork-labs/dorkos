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
import { withOwnerDoors } from './connector-owner-doors.js';
import { ReconciliationNeedsConfirmationError } from '../../services/connectors/reconciliation/reconciliation-error.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';
import {
  resetHeldStepUpsForTests,
  stepUpActionHash,
} from '../../services/core/auth/step-up/step-up-holds.js';
import { requestCodeForHash } from '../../services/core/auth/step-up/request-code.js';

const OWNER = { kind: 'local_install', installationId: 'northwind-install' } as const;
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;
const EXCLUSIONS = '/api/connectors/connections/connection-a/exclusions/agent-a';

describe('connected-app decision confirmation', () => {
  const resolveOwner = vi.fn((): unknown => OWNER);
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
  const owner = frontDoorStepUpHarness(() =>
    withOwnerDoors(createConnectorManagementRoutes, {
      registry: { migrationHealth: () => ({ status: 'ready', migrated: false }) },
      reviews,
      reconciliation,
      exclusions,
      agentRequests,
      resolveOwner,
      loginEnabled: () => true,
      trustedOrigins: () => [ORIGIN],
    } as unknown as Parameters<typeof createConnectorManagementRoutes>[0])
  );
  beforeEach(() => {
    vi.clearAllMocks();
    resetHeldStepUpsForTests();
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
        'held_by_another_browser'
      );
      expect(write).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
        ok: true,
        status,
      });
      expect(write).toHaveBeenCalledOnce();
    }
  );

  // DOR-4978: these three moved onto the mount behind the account-decision bar
  // and the front-door hold. Their holds bind what the hand routes bound.
  it.each([
    [
      'post',
      '/api/connectors/agent-requests/request-a/decision',
      { decision: 'current_access', connectionId: 'connection-a' },
      'request-a',
      {
        op: 'answer-agent-request',
        requestId: 'request-a',
        decision: { decision: 'current_access', connectionId: 'connection-a', eventScopes: [] },
      },
    ],
    [
      'post',
      '/api/connectors/agent-requests/request-a/authentication-flows',
      { providerInstanceId: 'provider-a', label: 'Northwind mail' },
      'request-a',
      {
        op: 'connect-for-agent-request',
        requestId: 'request-a',
        providerInstanceId: 'provider-a',
        label: 'Northwind mail',
      },
    ],
    [
      'delete',
      EXCLUSIONS,
      undefined,
      'connection-a',
      { op: 'let-agent-back-in', connectionId: 'connection-a', agentId: 'agent-a' },
    ],
  ] as const)(
    '%s %s holds with the request code its hand route showed',
    async (method, url, body, target, input) => {
      const ask = owner.call(method, url, 'own-tunnel');
      const held = await (body === undefined ? ask : ask.send(body));
      expect(held.status).toBe(428);
      const hash = stepUpActionHash({ kind: 'connection.grant', target, input });
      expect(held.body.requestCode).toBe(requestCodeForHash(hash));
    }
  );

  it('runs the owner bar afresh on the confirm, and a confirm by another owner is refused while the hold stays', async () => {
    const held = await owner
      .call('post', '/api/connectors/agent-requests/request-a/decision', 'own-tunnel')
      .send({ decision: 'current_access', connectionId: 'connection-a' });
    expect(held.status).toBe(428);
    const other = { kind: 'local_install', installationId: 'someone-else' };
    resolveOwner.mockReturnValueOnce(other);
    const refused = await owner.confirm(held.body.heldActionId, 'own-tunnel');
    expect(refused.status).toBe(404);
    expect(agentRequests.resolve).not.toHaveBeenCalled();
    const done = await owner.confirm(held.body.heldActionId, 'own-tunnel');
    expect(done.body).toMatchObject({ ok: true, status: 200 });
    expect(agentRequests.resolve).toHaveBeenCalledWith(
      OWNER,
      'request-a',
      { decision: 'current_access', connectionId: 'connection-a', eventScopes: [] },
      expect.any(AbortSignal)
    );
  });

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

  // Security M1 on DOR-4355 M3: "confirm who can use it as it stands" settles the
  // review, which can turn suspended grants back on.
  it('holds confirming access as it stands (grants: [])', async () => {
    const res = await owner
      .call('post', '/api/connectors/reconciliation/apply', 'own-tunnel')
      .send({ previewId: 'preview-a', grants: [] });
    expect(res.status).toBe(428);
    expect(reconciliation.apply).not.toHaveBeenCalled();
  });

  it('sends a named narrowing as narrowing, so the service can refuse it inside its write', async () => {
    const body = {
      previewId: 'preview-a',
      grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
    };
    await owner.call('post', '/api/connectors/reconciliation/apply', 'own-tunnel').send(body);
    expect(reconciliation.apply).toHaveBeenCalledWith(OWNER, body, expect.any(AbortSignal), {
      onlyNarrowing: true,
    });
  });

  it('holds a narrowing that would also settle the review, and writes nothing until confirmed', async () => {
    reconciliation.apply.mockRejectedValueOnce(new ReconciliationNeedsConfirmationError());
    const held = await owner
      .call('post', '/api/connectors/reconciliation/apply', 'own-tunnel')
      .send({ previewId: 'preview-a', grants: [{ agentId: 'agent-a', operationRevisionIds: [] }] });
    expect(held.status).toBe(428);
    expect(reconciliation.apply).toHaveBeenCalledOnce();
    const confirmed = await owner.confirm(held.body.heldActionId, 'own-tunnel');
    expect(confirmed.body).toMatchObject({ ok: true, status: 200 });
    expect(reconciliation.apply).toHaveBeenLastCalledWith(
      OWNER,
      expect.anything(),
      expect.any(AbortSignal),
      { onlyNarrowing: false }
    );
  });
});

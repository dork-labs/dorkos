/** Existing person-answer gates also protect every new queue approval. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { createApprovalsRoutes } from '../../../routes/approvals.js';
import { honoGroupListener } from '../../../http/__tests__/hono-group-listener.js';
import { markIngress } from '../../core/remote/ingress-mark.js';
import { ApprovalService, hashApprovalInput } from '../../core/approvals/index.js';
import { eventFanOut } from '../../core/event-fan-out.js';

vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));
const target = swappableServer();
let approvals: ApprovalService;
beforeEach(() => {
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  approvals = new ApprovalService(createTestDb(), {
    describeCapability: () => ({ title: 'Change work queue', tier: 'destructive' }),
  });
});
afterEach(() => vi.restoreAllMocks());

function app(kind: 'person' | 'agent' | 'schedule' | 'heartbeat' | 'wifi' | 'remote') {
  return target.mount(
    honoGroupListener(
      {
        path: '/api/approvals',
        routes: createApprovalsRoutes(approvals, { isLoginEnabled: () => false }),
      },
      {
        before: async (c, next) => {
          if (['agent', 'schedule', 'heartbeat'].includes(kind))
            c.set('agentIdentity', {
              agentPath: '/agents/scout',
              displayName: 'Scout',
              createdAt: 'x',
            });
          if (kind === 'wifi') markIngress(c.env.incoming, 'wifi');
          if (kind === 'remote') markIngress(c.env.incoming, 'own-tunnel');
          await next();
        },
      }
    )
  );
}

it.each(['agent', 'schedule', 'heartbeat', 'wifi'] as const)(
  '%s cannot answer a queue increase',
  async (kind) => {
    const binding = {
      capabilityId: 'work-queue.configure',
      inputHash: hashApprovalInput({ enabled: true }),
    };
    const ticket = approvals.request({
      ...binding,
      summary: 'Scout wants to turn on Atlas’s queue',
      raisesPermissions: true,
    });
    const result = await request(app(kind))
      .post(`/api/approvals/${ticket.approvalId}/grant`)
      .send({ answer: 'once' });
    expect(result.status).toBe(403);
    expect(approvals.consume(ticket.token, binding).outcome).toBe('pending');
  }
);

it('a person can answer once, and a remote Always allow saves no standing grant', async () => {
  const binding = {
    capabilityId: 'work-queue.add',
    inputHash: hashApprovalInput({ title: 'Read' }),
  };
  const ticket = approvals.request({
    ...binding,
    summary: 'Scout wants Atlas to read',
    requestedByPath: '/agents/scout',
    area: 'agents',
    raisesPermissions: true,
  });
  const remote = await request(app('remote'))
    .post(`/api/approvals/${ticket.approvalId}/grant`)
    .send({ answer: 'always' });
  expect(remote.status).toBe(409);
  expect(approvals.consume(ticket.token, binding).outcome).toBe('pending');
  const person = await request(app('person'))
    .post(`/api/approvals/${ticket.approvalId}/grant`)
    .send({ answer: 'once' });
  expect(person.status).toBe(200);
  expect(approvals.consume(ticket.token, binding).outcome).toBe('granted');
});

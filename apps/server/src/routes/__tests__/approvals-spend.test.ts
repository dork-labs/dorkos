/**
 * A paid-run card answers only to a person in DorkOS (DOR-4204 PR 2, Security
 * Must 2): Allow once, from the owner at the app, re-checked against the limit
 * at the tap. Never Always, never from a Wi-Fi sign-in, never from an agent.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wifi = vi.hoisted(() => ({ on: false }));
vi.mock('../../services/core/auth/sessions/wifi-level.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/sessions/wifi-level.js')>()),
  isFromWifi: () => wifi.on,
}));
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user?: { userId: string }) => user?.userId === 'owner',
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));

import type { Server } from 'node:http';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService, hashApprovalInput } from '../../services/core/approvals/index.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { createApprovalsRoutes } from '../approvals.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createPermissionWorld } from '../../services/core/permissions/__tests__/permission-fixtures.js';

const LIMIT_RECEIPT = 'The monthly limit was reached. Nothing was spent.';

describe('a paid-run card', () => {
  const target = swappableServer();
  let approvals: ApprovalService;
  let tapRefusal: string | null;
  let app: Server;
  let routes: ReturnType<typeof createApprovalsRoutes>;
  let loginOn: boolean;

  beforeEach(() => {
    wifi.on = false;
    tapRefusal = null;
    approvals = new ApprovalService(createTestDb(), {
      describeCapability: () => ({ title: 'Run a connected app action', tier: 'observe' }),
    });
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    loginOn = false;
    routes = createApprovalsRoutes(approvals, {
      activity: { emit: async () => undefined } as unknown as ActivityService,
      permissions: createPermissionWorld({ preset: 'full', agents: [] }).service,
      isLoginEnabled: () => loginOn,
      spending: { tapRefusal: () => tapRefusal },
    });
    app = target.mount(honoGroupListener({ path: '/api/approvals', routes }));
  });

  afterEach(() => vi.restoreAllMocks());

  function spendCard() {
    return approvals.request({
      capabilityId: 'connectors.execute_read',
      inputHash: hashApprovalInput({ query: 'Northwind pricing' }),
      summary: 'Acme Search: Search the web for "Northwind pricing".',
      requestedBy: 'kestrel',
      serviceAction: {
        serviceId: 'tavily',
        serviceName: 'Acme Search',
        accountLabel: 'Work',
        actionName: 'Search the web',
        details: [],
        keptCardBecause: 'spend',
        spend: {
          priceMicro: '300000',
          priceSource: 'person',
          limitMicro: '1000000',
          leftMicro: '200000',
          currency: 'USD',
        },
      },
    });
  }

  const grant = (id: string, body: object = {}) =>
    request(app).post(`/api/approvals/${id}/grant`).send(body);

  it('is allowed once by the person at the app', async () => {
    const card = spendCard();
    expect((await grant(card.approvalId)).status).toBe(200);
  });

  it('is never answered from a Wi-Fi sign-in', async () => {
    const card = spendCard();
    wifi.on = true;
    const res = await grant(card.approvalId);
    expect(res.status).toBe(403);
    expect(approvals.answerScope(card.approvalId)).toBeDefined();
  });

  it('is never allowed always: the limit is what "always" means for money', async () => {
    const card = spendCard();
    const res = await grant(card.approvalId, { answer: 'always' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(approvals.answerScope(card.approvalId)).toBeDefined();
  });

  it('is never answered by an agent', async () => {
    const card = spendCard();
    const res = await request(app)
      .post(`/api/approvals/${card.approvalId}/grant`)
      .set(AGENT_IDENTITY_HEADER, 'agent-token')
      .send({});
    expect(res.status).toBe(403);
  });

  it('is refused at the tap when the limit no longer fits, and nothing is spent (spec §4.4)', async () => {
    const card = spendCard();
    tapRefusal = LIMIT_RECEIPT;
    const res = await grant(card.approvalId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SPEND_LIMIT', error: LIMIT_RECEIPT });
    expect(
      approvals.consume(card.token, {
        capabilityId: 'connectors.execute_read',
        inputHash: hashApprovalInput({ query: 'Northwind pricing' }),
      }).outcome
    ).not.toBe('granted');
  });

  it('is never answered by a signed-in person who does not own this DorkOS', async () => {
    const card = spendCard();
    loginOn = true;
    const asUser = (userId: string) =>
      target.mount(
        honoGroupListener(
          { path: '/api/approvals', routes },
          {
            before: async (c, next) => {
              c.set('user', { userId, credential: 'cookie', sessionId: `sess-${userId}` });
              await next();
            },
          }
        )
      );
    const teammate = await request(asUser('teammate'))
      .post(`/api/approvals/${card.approvalId}/grant`)
      .send({});
    expect(teammate.status).toBe(403);
    expect(approvals.answerScope(card.approvalId)?.state).toBe('pending');
    const owner = await request(asUser('owner'))
      .post(`/api/approvals/${card.approvalId}/grant`)
      .send({});
    expect(owner.status).toBe(200);
  });
});

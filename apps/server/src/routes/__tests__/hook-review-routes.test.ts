/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { approvals } from '@dorkos/db';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { ApprovalService } from '../../services/core/approvals/approval-service.js';
import { createApprovalsRoutes } from '../approvals.js';
import { hookProjectionBinding } from '../../services/harness/hook-approval.js';
import {
  describeHookProjection,
  HOOK_CARD_PRESENTATION,
  summariseHookProjection,
} from '../../services/harness/hook-card.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';

const harnessConfig = vi.hoisted(() => ({
  value: { autoSync: true, approvedHooks: [] as string[], refusedHooks: [] as string[] },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'harness' ? harnessConfig.value : undefined)),
    set: vi.fn((key: string, value: typeof harnessConfig.value) => {
      if (key === 'harness') harnessConfig.value = value;
    }),
  },
}));
vi.mock('../../services/harness/project-with-consent.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  scanHookRequests: vi.fn(() => [full]),
}));
vi.mock('../../services/harness/ask-withheld-hooks.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  followReaskedHookRow: vi.fn(),
}));
const full = {
  projectPath: '/workspaces/cedar',
  packageName: 'lunar-hooks',
  hooks: [{ event: 'Stop', command: 'echo safe' }],
};
const input = () => ({
  ...hookProjectionBinding(full, true),
  summary: summariseHookProjection(full),
  detail: describeHookProjection(full),
  passive: true,
  packageRequest: {
    kind: 'hooks' as const,
    presentation: HOOK_CARD_PRESENTATION,
    request: full,
    options: { notInstalledByDorkos: true },
  },
});
const target = swappableServer();
let db: ReturnType<typeof createTestDb>;
let service: ApprovalService;
beforeEach(() => {
  harnessConfig.value = { autoSync: true, approvedHooks: [], refusedHooks: [] };
  db = createTestDb();
  service = new ApprovalService(db);
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
});
afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
});
function app(login: boolean, credential?: 'cookie' | 'api-key') {
  return target.mount(
    honoGroupListener(
      {
        path: '/api/approvals',
        routes: createApprovalsRoutes(service, {
          dorkHome: '/test-home',
          isLoginEnabled: () => login,
        }),
      },
      {
        before: async (c, next) => {
          if (credential) c.set('user', { userId: 'test-owner', credential });
          await next();
        },
      }
    )
  );
}
function decline() {
  const ticket = service.request(input());
  service.deny(ticket.approvalId);
  return ticket.approvalId;
}

describe('person-only individual hook reviews', () => {
  it('returns a safe declined row and creates one new pending request, without a token response', async () => {
    const id = decline();
    const server = app(true, 'cookie');
    const history = await request(server).get('/api/approvals/declined-hooks');
    expect(history.status).toBe(200);
    expect(history.body.approvals[0]).toMatchObject({
      approval: { approvalId: id },
      declineKind: 'refused',
      canAskAgain: true,
    });
    expect(history.text).not.toMatch(/tokenHash|packageRequest|inputHash/);
    const result = await request(server)
      .post(`/api/approvals/${id}/ask-again`)
      .send({ ids: ['other'], command: 'untrusted extra' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, approvalId: expect.any(String) });
    expect(service.listPending()).toHaveLength(1);
    expect(service.listPending()[0]?.detail).toBe(describeHookProjection(full));
    expect((await request(server).post(`/api/approvals/${id}/ask-again`)).status).toBe(409);
    expect(db.select().from(approvals).all()).toHaveLength(2);
  });

  it.each(['agent', 'approval-token', 'api-key', 'signed-out'] as const)(
    'refuses a %s caller before starting any review',
    async (kind) => {
      const id = decline();
      const server = app(
        kind !== 'agent' && kind !== 'approval-token',
        kind === 'api-key' ? 'api-key' : undefined
      );
      let attempt = request(server).post(`/api/approvals/${id}/ask-again`);
      if (kind === 'agent') attempt = attempt.set('X-DorkOS-Agent', 'test-agent');
      if (kind === 'approval-token') attempt = attempt.set('X-DorkOS-Approval', 'test-token');
      expect([401, 403]).toContain((await attempt).status);
      expect(db.select().from(approvals).all()).toHaveLength(1);
      expect(service.listPending()).toHaveLength(0);
    }
  );

  it('has no bulk re-ask route', async () => {
    decline();
    const result = await request(app(false))
      .post('/api/approvals/ask-again')
      .send({ approvalIds: ['one', 'two'] });
    expect(result.status).toBe(404);
    expect(service.listPending()).toHaveLength(0);
  });

  it('returns the separate incomplete outcome without changing the denied audit state', async () => {
    const ticket = service.request({
      capabilityId: 'harness.project_hooks',
      inputHash: 'legacy',
      summary: 'old cut card',
    });
    const result = await request(app(false)).post(`/api/approvals/${ticket.approvalId}/deny`);
    expect(result.body).toMatchObject({ outcome: 'incomplete' });
    expect(db.select().from(approvals).all()[0]).toMatchObject({
      state: 'denied',
      declineKind: 'incomplete',
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

// Mock the cloud-link manager accessor — the route is thin over it, so the
// route test only proves wiring + response shapes, not the flow (covered by
// cloud-link.test.ts). vi.hoisted() ensures mockManager is initialized before
// vi.mock's factory runs (vi.mock is hoisted above all imports).
const mockManager = vi.hoisted(() => ({
  startLink: vi.fn(),
  getStatus: vi.fn(),
  unlink: vi.fn(),
  getSummary: vi.fn(),
}));
vi.mock('../../services/core/auth/cloud-link.js', () => ({
  getCloudLinkManager: () => mockManager,
}));

// The plan-aware routes are equally thin over `services/core/cloud`, so they
// are mocked the same way: this file proves the wiring, the graceful-degradation
// shapes and the problem passthrough, while `services/core/cloud/__tests__`
// proves the reads themselves against the contract fixtures.
const mockPlan = vi.hoisted(() => ({
  readPlanOverview: vi.fn(),
  readUsage: vi.fn(),
  readNudge: vi.fn(),
  listMembers: vi.fn(),
  listOrgs: vi.fn(),
  listSeats: vi.fn(),
  assignSeat: vi.fn(),
  releaseSeat: vi.fn(),
}));
vi.mock('../../services/core/cloud/plan.js', () => mockPlan);

const mockV1 = vi.hoisted(() => ({
  isCloudLinked: vi.fn(() => true),
  cloudInstanceRef: vi.fn(() => 'ref_test'),
  problemOf: vi.fn(() => null as unknown),
}));
vi.mock('../../services/core/cloud/v1-client.js', () => mockV1);

import cloudRouter from '../cloud.js';

const manager = mockManager;

const app = express();
app.use(express.json());
app.use('/api/cloud', cloudRouter);

// ONE listener for the whole file, reused by every request — the DOR-458
// listener-churn pattern, closed here per DOR-545. See listeningServer's own
// doc for why a per-request listener flakes under a full-suite run.
const server = listeningServer(app);

describe('cloud routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/cloud/link/start', () => {
    it('returns the device codes from the manager', async () => {
      manager.startLink.mockResolvedValue({
        userCode: 'ABCD1234',
        verificationUri: 'https://dorkos.ai/activate',
        expiresAt: '2026-07-03T00:30:00Z',
      });
      const res = await request(server).post('/api/cloud/link/start').expect(200);
      expect(res.body).toEqual({
        userCode: 'ABCD1234',
        verificationUri: 'https://dorkos.ai/activate',
        expiresAt: '2026-07-03T00:30:00Z',
      });
      expect(manager.startLink).toHaveBeenCalledOnce();
    });

    it('returns 502 when the cloud is unreachable', async () => {
      manager.startLink.mockRejectedValue(new Error('fetch failed'));
      const res = await request(server).post('/api/cloud/link/start').expect(502);
      expect(res.body.error).toMatch(/cloud/i);
    });
  });

  describe('GET /api/cloud/link/status', () => {
    it('returns the link-flow state machine', async () => {
      manager.getStatus.mockReturnValue({
        state: 'pending',
        lastHeartbeatAt: undefined,
      });
      const res = await request(server).get('/api/cloud/link/status').expect(200);
      expect(res.body.state).toBe('pending');
    });

    it('surfaces the unlinked state', async () => {
      manager.getStatus.mockReturnValue({ state: 'unlinked' });
      const res = await request(server).get('/api/cloud/link/status').expect(200);
      expect(res.body).toEqual({ state: 'unlinked' });
    });
  });

  describe('POST /api/cloud/unlink', () => {
    it('unlinks and returns ok', async () => {
      manager.unlink.mockResolvedValue(undefined);
      const res = await request(server).post('/api/cloud/unlink').expect(200);
      expect(res.body).toEqual({ ok: true });
      expect(manager.unlink).toHaveBeenCalledOnce();
    });

    it('returns 500 when unlink throws', async () => {
      manager.unlink.mockRejectedValue(new Error('boom'));
      await request(server).post('/api/cloud/unlink').expect(500);
    });
  });

  describe('GET /api/cloud/status', () => {
    it('returns the settled linked summary', async () => {
      manager.getSummary.mockReturnValue({
        linked: true,
        accountLabel: 'Kai',
        lastHeartbeatAt: '2026-07-03T00:00:00Z',
      });
      const res = await request(server).get('/api/cloud/status').expect(200);
      expect(res.body).toEqual({
        linked: true,
        accountLabel: 'Kai',
        lastHeartbeatAt: '2026-07-03T00:00:00Z',
      });
    });

    it('reports not-linked', async () => {
      manager.getSummary.mockReturnValue({
        linked: false,
        accountLabel: null,
        lastHeartbeatAt: null,
      });
      const res = await request(server).get('/api/cloud/status').expect(200);
      expect(res.body.linked).toBe(false);
    });
  });

  describe('the plan-aware routes', () => {
    it('hides the plan card on an install with no cloud account', async () => {
      mockPlan.readPlanOverview.mockResolvedValue(null);
      const res = await request(server).get('/api/cloud/plan').expect(200);
      expect(res.body).toEqual({ available: false });
    });

    it('passes the entitlement and the balance through untouched', async () => {
      mockPlan.readPlanOverview.mockResolvedValue({
        entitlements: { planId: 'pl_opaque_0000', planDisplayName: 'what the service called it' },
        balance: { owedMicro: '0' },
      });
      const res = await request(server).get('/api/cloud/plan').expect(200);
      expect(res.body.available).toBe(true);
      expect(res.body.entitlements.planDisplayName).toBe('what the service called it');
      expect(res.body.balance.owedMicro).toBe('0');
    });

    it('answers 502 without echoing a body when the service is unwell', async () => {
      mockPlan.readPlanOverview.mockRejectedValue(new Error('boom'));
      const res = await request(server).get('/api/cloud/plan').expect(502);
      expect(res.body.entitlements).toBeUndefined();
    });

    it('defaults the usage grouping to seat and refuses an unknown one', async () => {
      mockPlan.readUsage.mockResolvedValue({ rows: [] });
      await request(server).get('/api/cloud/usage').expect(200);
      expect(mockPlan.readUsage).toHaveBeenCalledWith('seat');
      await request(server).get('/api/cloud/usage?groupBy=everything').expect(400);
    });

    it('hides the nudge when there is none, and also when the read fails', async () => {
      mockPlan.readNudge.mockResolvedValue(null);
      expect((await request(server).get('/api/cloud/nudge').expect(200)).body).toEqual({
        available: false,
      });
      mockPlan.readNudge.mockRejectedValue(new Error('boom'));
      expect((await request(server).get('/api/cloud/nudge').expect(200)).body).toEqual({
        available: false,
      });
    });

    it('renders a seat refusal with the service`s own words', async () => {
      const problem = {
        code: 'person_seat_required',
        status: 403,
        title: 'This needs a person seat.',
        requiredPlanId: 'pl_opaque_0001',
        requiredPlanDisplayName: 'what the service called it',
      };
      mockPlan.assignSeat.mockRejectedValue(new Error('refused'));
      mockV1.problemOf.mockReturnValue(problem);
      // 200, deliberately: the client's `fetchJSON` throws on every non-2xx, so
      // passing the refusal's status through would bury the service's words in
      // an exception and leave the surface with nothing to render. The status
      // rides inside `problem.status`.
      const res = await request(server)
        .post('/api/cloud/seats/seat_0001/assign')
        .send({ subject: { kind: 'user', id: 'acct_0001' } })
        .expect(200);
      expect(res.body).toEqual({ ok: false, problem });
      expect(res.body.problem.status).toBe(403);
      mockV1.problemOf.mockReturnValue(null);
    });

    it('refuses a seat write while unlinked instead of pretending it worked', async () => {
      mockV1.isCloudLinked.mockReturnValue(false);
      const res = await request(server).post('/api/cloud/seats/seat_0001/release').expect(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toMatch(/not linked/i);
      expect(mockPlan.releaseSeat).not.toHaveBeenCalled();
      mockV1.isCloudLinked.mockReturnValue(true);
    });

    it('hides the member list on an install with no cloud account', async () => {
      mockPlan.listMembers.mockResolvedValue(null);
      const res = await request(server).get('/api/cloud/orgs/org_0001/members').expect(200);
      expect(res.body).toEqual({ available: false });
    });

    it('reports the credits path as off, and selecting it mints nothing', async () => {
      const res = await request(server).get('/api/cloud/credits').expect(200);
      expect(res.body.enabled).toBe(false);
      const selected = await request(server).post('/api/cloud/credits/select').expect(200);
      expect(selected.body.enabled).toBe(false);
      expect(selected.body.ready).toBe(false);
    });
  });
});

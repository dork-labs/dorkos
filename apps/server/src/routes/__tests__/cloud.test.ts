import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { logger } from '../../lib/logger.js';

// Mock the cloud-link manager accessor — the route is thin over it, so the
// route test only proves wiring + response shapes, not the flow (covered by
// cloud-link.test.ts). vi.hoisted() ensures mockManager is initialized before
// vi.mock's factory runs (vi.mock is hoisted above all imports).
const mockManager = vi.hoisted(() => ({
  startLink: vi.fn(),
  getStatus: vi.fn(),
  unlink: vi.fn(),
  cancelLink: vi.fn(),
  getSummary: vi.fn(),
  checkLink: vi.fn(),
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
  problemOf: vi.fn(() => null as unknown),
  isAbsent: vi.fn(() => false),
}));
vi.mock('../../services/core/cloud/v1-client.js', () => mockV1);

const mockCredits = vi.hoisted(() => ({
  creditsKilled: vi.fn(() => false),
}));
vi.mock('../../services/core/cloud/credits-availability.js', () => mockCredits);

const STATUS = { enabled: true, killed: false, linked: true, ready: false, runtimes: {} };
const mockCreditsRuntimes = vi.hoisted(() => ({
  creditsStatus: vi.fn(async () => STATUS as unknown),
  creditsRuntimeViews: vi.fn(() => [] as unknown[]),
}));
vi.mock('../../services/core/cloud/credits-runtimes.js', () => mockCreditsRuntimes);

const mockCreditsDefaults = vi.hoisted(() => ({
  creditsIsDefaultFor: vi.fn(() => false),
  setCreditsDefault: vi.fn(),
  undoFilledDefaults: vi.fn(() => []),
  dismissCreditsNotice: vi.fn(),
}));
vi.mock('../../services/core/cloud/credits-defaults.js', () => mockCreditsDefaults);

// Whether login is on, for the person-only bar on the link check.
const posture = vi.hoisted(() => ({ authEnabled: false }));
// The live runtimes the default route asks whether a whole-runtime switch
// would cut a reply off.
const liveRuntimes = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: { listRuntimes: () => liveRuntimes.list },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: posture.authEnabled } : undefined),
    onChange: () => () => {},
  },
}));

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
    mockCredits.creditsKilled.mockReturnValue(false);
    mockV1.isCloudLinked.mockReturnValue(true);
    mockCreditsRuntimes.creditsStatus.mockResolvedValue(STATUS);
    mockCreditsRuntimes.creditsRuntimeViews.mockReturnValue([
      {
        type: 'claude-code',
        capabilities: { credits: { protocol: 'anthropic-messages', scope: 'conversation' } },
        wired: true,
      },
      { type: 'codex', capabilities: {} },
    ]);
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

  describe('POST /api/cloud/link/cancel', () => {
    it('stops the link flow and answers the state it settled in', async () => {
      manager.cancelLink.mockResolvedValue({ state: 'linked', accountLabel: 'kai@dork.dev' });
      const res = await request(server).post('/api/cloud/link/cancel').expect(200);
      expect(res.body).toEqual({ state: 'linked', accountLabel: 'kai@dork.dev' });
      expect(manager.cancelLink).toHaveBeenCalledOnce();
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

  describe('POST /api/cloud/link/check', () => {
    it('asks the account now and answers the summary that results', async () => {
      manager.checkLink.mockResolvedValue({
        linked: false,
        accountLabel: null,
        lastHeartbeatAt: null,
      });
      const res = await request(server).post('/api/cloud/link/check').expect(200);
      expect(res.body).toEqual({ linked: false, accountLabel: null, lastHeartbeatAt: null });
      expect(manager.checkLink).toHaveBeenCalledTimes(1);
    });

    it('refuses an agent, which never needs it, and checks nothing', async () => {
      manager.checkLink.mockClear();
      await request(server)
        .post('/api/cloud/link/check')
        .set('x-dorkos-agent', 'agent-token-abc')
        .expect(403);
      await request(server)
        .post('/api/cloud/link/check')
        .set('x-dorkos-approval', 'approval-token-abc')
        .expect(403);
      posture.authEnabled = true;
      try {
        // Login on and no browser session: an API key, or nothing at all.
        const res = await request(server).post('/api/cloud/link/check').expect(403);
        expect(res.body.code).toBe('person_only');
      } finally {
        posture.authEnabled = false;
      }
      expect(manager.checkLink).not.toHaveBeenCalled();
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

    it('relays the unit each response names, so the client can render its amounts', async () => {
      const denomination = { currency: 'XTS', microPerCredit: '250' };
      mockPlan.readPlanOverview.mockResolvedValue({
        entitlements: { planId: 'pl_opaque_0000', denomination },
        balance: { owedMicro: '0', denomination },
      });
      mockPlan.readUsage.mockResolvedValue({ rows: [], denomination });
      mockPlan.readNudge.mockResolvedValue({ savingMicro: '0', denomination });
      const plan = (await request(server).get('/api/cloud/plan').expect(200)).body;
      expect(plan.entitlements.denomination).toEqual(denomination);
      expect(plan.balance.denomination).toEqual(denomination);
      const usage = (await request(server).get('/api/cloud/usage').expect(200)).body;
      expect(usage.usage.denomination).toEqual(denomination);
      const nudge = (await request(server).get('/api/cloud/nudge').expect(200)).body;
      expect(nudge.nudge.denomination).toEqual(denomination);
    });

    it('answers 502 without echoing a body when the service is unwell', async () => {
      mockPlan.readPlanOverview.mockRejectedValue(new Error('boom'));
      const res = await request(server).get('/api/cloud/plan').expect(502);
      expect(res.body.entitlements).toBeUndefined();
    });

    it('logs the problem code and status when a read fails', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      mockPlan.readPlanOverview.mockRejectedValue(new Error('boom'));
      mockV1.problemOf.mockReturnValue({
        code: 'temporarily_unavailable',
        status: 503,
        title: 'Down',
      });
      await request(server).get('/api/cloud/plan').expect(502);
      expect(warn).toHaveBeenCalledWith(
        '[Cloud] Could not read the plan',
        expect.objectContaining({ code: 'temporarily_unavailable', status: 503 })
      );
      warn.mockRestore();
      mockV1.problemOf.mockReturnValue(null);
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

    it('reports the credits status, which carries no credential', async () => {
      const res = await request(server).get('/api/cloud/credits').expect(200);
      expect(res.body).toEqual(STATUS);
    });

    it('records a person’s pick of credits as the runtime’s default', async () => {
      await request(server)
        .put('/api/cloud/credits/default')
        .send({ runtime: 'claude-code', useCredits: true })
        .expect(200);
      expect(mockCreditsDefaults.setCreditsDefault).toHaveBeenCalledExactlyOnceWith(
        'claude-code',
        true
      );
    });

    it('refuses to set credits on a runtime that does not declare them', async () => {
      const res = await request(server)
        .put('/api/cloud/credits/default')
        .send({ runtime: 'codex', useCredits: true })
        .expect(400);
      expect(res.body.error).toBe("Codex can't run on DorkOS credits yet.");
      expect(mockCreditsDefaults.setCreditsDefault).not.toHaveBeenCalled();
    });

    it('refuses to switch a whole runtime while it is in the middle of a reply, and says why', async () => {
      liveRuntimes.list = [
        {
          type: 'opencode',
          getCapabilities: () => ({
            credits: { protocol: 'openai-chat-completions', scope: 'runtime' },
          }),
          hasRunningTurns: () => true,
        },
      ];
      try {
        for (const [useCredits, current] of [
          [true, false],
          [false, true],
        ] as const) {
          mockCreditsDefaults.creditsIsDefaultFor.mockReturnValue(current);
          const res = await request(server)
            .put('/api/cloud/credits/default')
            .send({ runtime: 'opencode', useCredits })
            .expect(409);
          expect(res.body.error).toBe(
            'OpenCode is in the middle of a reply. Switch once it finishes, so nothing it is doing is cut off.'
          );
        }
        expect(mockCreditsDefaults.setCreditsDefault).not.toHaveBeenCalled();
        // A change that changes nothing is never refused.
        mockCreditsDefaults.creditsIsDefaultFor.mockReturnValue(false);
        await request(server)
          .put('/api/cloud/credits/default')
          .send({ runtime: 'opencode', useCredits: false })
          .expect(200);
      } finally {
        liveRuntimes.list = [];
      }
    });

    it('refuses a runtime that declares credits in a format the endpoint does not serve', async () => {
      mockCreditsRuntimes.creditsRuntimeViews.mockReturnValueOnce([
        {
          type: 'codex',
          capabilities: { credits: { protocol: 'openai-responses', scope: 'conversation' } },
          wired: false,
        },
      ]);
      await request(server)
        .put('/api/cloud/credits/default')
        .send({ runtime: 'codex', useCredits: true })
        .expect(400);
      expect(mockCreditsDefaults.setCreditsDefault).not.toHaveBeenCalled();
    });

    it('refuses to turn credits on while they cannot be had, so no turn is set up to fail', async () => {
      mockV1.isCloudLinked.mockReturnValue(false);
      await request(server)
        .put('/api/cloud/credits/default')
        .send({ runtime: 'claude-code', useCredits: true })
        .expect(409);
      mockV1.isCloudLinked.mockReturnValue(true);
      mockCredits.creditsKilled.mockReturnValue(true);
      await request(server)
        .put('/api/cloud/credits/default')
        .send({ runtime: 'claude-code', useCredits: true })
        .expect(409);
      expect(mockCreditsDefaults.setCreditsDefault).not.toHaveBeenCalled();
    });

    it('always lets a person go back to their own sign-in', async () => {
      mockV1.isCloudLinked.mockReturnValue(false);
      mockCredits.creditsKilled.mockReturnValue(true);
      await request(server)
        .put('/api/cloud/credits/default')
        .send({ runtime: 'claude-code', useCredits: false })
        .expect(200);
      expect(mockCreditsDefaults.setCreditsDefault).toHaveBeenCalledWith('claude-code', false);
    });

    it('undoes the filled-in defaults and settles notices', async () => {
      await request(server).post('/api/cloud/credits/undo-filled').expect(200);
      expect(mockCreditsDefaults.undoFilledDefaults).toHaveBeenCalledOnce();
      await request(server)
        .post('/api/cloud/credits/notices/dismiss')
        .send({ kind: 'signed-in', runtime: 'claude-code' })
        .expect(200);
      expect(mockCreditsDefaults.dismissCreditsNotice).toHaveBeenCalledWith({
        kind: 'signed-in',
        runtime: 'claude-code',
      });
      await request(server)
        .post('/api/cloud/credits/notices/dismiss')
        .send({ kind: 'nonsense' })
        .expect(400);
    });
  });
});

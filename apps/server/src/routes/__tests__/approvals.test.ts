/**
 * Tests for the approvals routes (spec `agent-trust` §3.3) — the cockpit lists
 * what is waiting and records the operator's decision.
 *
 * The `who may decide` block is the important one. Review reproduced a complete
 * self-approval chain against the real routers: ask for a destructive capability
 * (the 202 hands the caller both the approval id AND its token), grant it with a
 * bare request that simply omits the agent header, retry with the token, done.
 * Those cases are pinned here in both login postures, because the refusal must not
 * depend on accounts being switched on — `auth.enabled` defaults to `false`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  ApprovalGrantService,
  ApprovalService,
  APPROVAL_TTL_MS,
  hashApprovalInput,
} from '../../services/core/approvals/index.js';
import { APPROVAL_TOKEN_HEADER } from '../../services/core/capabilities/index.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { createApprovalsRouter } from '../approvals.js';

/** The action every test in this file asks approval for. */
const BINDING = {
  capabilityId: 'marketplace.uninstall',
  inputHash: hashApprovalInput({ name: 'sentry-monitor' }),
};

/** A resolved agent identity, as the real middleware attaches it. */
const AGENT_IDENTITY = {
  agentPath: '/Users/dev/agents/dorkbot',
  displayName: 'DorkBot',
  tierCeiling: 'destructive' as const,
  createdAt: new Date().toISOString(),
};

describe('approvals routes', () => {
  let approvals: ApprovalService;
  let grants: ApprovalGrantService;
  let app: express.Express;
  let emitted: { eventType: string; metadata?: Record<string, unknown> | null }[];

  /**
   * Build an app around the real router.
   *
   * @param options - Login posture, whether an agent identity is pre-resolved onto
   *   `res.locals` (what the real middleware does), and whether a signed-in user is.
   */
  function buildApp(
    options: {
      loginEnabled?: boolean;
      agentIdentity?: boolean;
      user?: { userId: string; credential: 'cookie' | 'api-key' };
      /** Whether the operator switched standing permissions on. Off by default. */
      standingGrants?: boolean;
    } = {}
  ): express.Express {
    const built = express();
    built.use(express.json());
    built.use((_req, res, next) => {
      if (options.agentIdentity) res.locals.agentIdentity = AGENT_IDENTITY;
      if (options.user) res.locals.user = options.user;
      next();
    });
    const activity = {
      emit: async (event: { eventType: string; metadata?: Record<string, unknown> | null }) => {
        emitted.push({ eventType: event.eventType, metadata: event.metadata });
      },
    } as unknown as ActivityService;
    built.use(
      '/api/approvals',
      createApprovalsRouter(approvals, grants, {
        activity,
        isLoginEnabled: () => options.loginEnabled === true,
        readStandingGrantSettings: () => ({
          enabled: options.standingGrants === true,
          windowMinutes: 480,
        }),
        describeCapability: (id) =>
          id === 'marketplace.uninstall' ? { title: 'Uninstall a marketplace package' } : undefined,
      })
    );
    return built;
  }

  beforeEach(() => {
    // A stand-in for the capability registry the real boot injects — the card's
    // title and tier are derived, never stated by the requester.
    const db = createTestDb();
    approvals = new ApprovalService(db, {
      describeCapability: (id) =>
        id === 'marketplace.uninstall'
          ? { title: 'Uninstall a marketplace package', tier: 'destructive' }
          : undefined,
    });
    grants = new ApprovalGrantService(db);
    emitted = [];
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    app = buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Ask for approval of the standard action. */
  function requestOne() {
    return approvals.request({
      ...BINDING,
      summary: 'Uninstall "sentry-monitor"',
      requestedBy: 'dorkbot',
    });
  }

  describe('GET /pending', () => {
    it('returns an empty list when nothing is waiting', async () => {
      const res = await request(app).get('/api/approvals/pending');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ approvals: [] });
    });

    it('returns the card payload and never the token', async () => {
      const ticket = requestOne();

      const res = await request(app).get('/api/approvals/pending');
      expect(res.status).toBe(200);
      expect(res.body.approvals).toHaveLength(1);
      expect(res.body.approvals[0]).toMatchObject({
        approvalId: ticket.approvalId,
        capabilityId: 'marketplace.uninstall',
        capabilityTitle: 'Uninstall a marketplace package',
        tier: 'destructive',
        summary: 'Uninstall "sentry-monitor"',
        requestedBy: 'dorkbot',
      });
      expect(res.text).not.toContain(ticket.token);
    });
  });

  describe('POST /:id/grant', () => {
    it('grants a pending approval so its token can be spent once', async () => {
      const ticket = requestOne();

      const res = await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, approvalId: ticket.approvalId, outcome: 'granted' });
      expect(approvals.consume(ticket.token, BINDING).outcome).toBe('granted');
    });

    it('404s an approval that does not exist', async () => {
      const res = await request(app).post('/api/approvals/01JZZZZZZZZZZZZZZZZZZZZZZZ/grant').send();
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('UNKNOWN_APPROVAL');
    });

    it('409s a second decision', async () => {
      const ticket = requestOne();
      await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send();

      const res = await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('APPROVAL_NOT_PENDING');
    });

    it('410s an approval whose window closed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
      const ticket = requestOne();
      vi.setSystemTime(new Date(Date.now() + APPROVAL_TTL_MS + 1));

      const res = await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send();
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('APPROVAL_EXPIRED');
    });
  });

  describe('POST /:id/deny', () => {
    it('denies with a reason the requester sees', async () => {
      const ticket = requestOne();

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/deny`)
        .send({ reason: 'not today' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, approvalId: ticket.approvalId, outcome: 'denied' });
      expect(approvals.consume(ticket.token, BINDING)).toEqual({
        outcome: 'denied',
        approvalId: ticket.approvalId,
        reason: 'not today',
      });
    });

    it('accepts a bare denial with no body at all (Express 5 leaves it undefined)', async () => {
      const ticket = requestOne();

      const res = await request(app).post(`/api/approvals/${ticket.approvalId}/deny`);
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('denied');
    });

    it('400s a reason that is not a string', async () => {
      const ticket = requestOne();

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/deny`)
        .send({ reason: 42 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_DENY_BODY');
      expect(res.body.details).toBeTruthy();
    });

    it('404s an approval that does not exist', async () => {
      const res = await request(app).post('/api/approvals/01JZZZZZZZZZZZZZZZZZZZZZZZ/deny').send();
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('UNKNOWN_APPROVAL');
    });
  });

  describe('who may decide', () => {
    it('403s a grant from a caller whose agent identity resolved', async () => {
      const ticket = requestOne();

      const res = await request(buildApp({ agentIdentity: true }))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
      // Untouched: the token still cannot be spent.
      expect(approvals.consume(ticket.token, BINDING).outcome).toBe('pending');
    });

    it('403s a deny from a caller whose agent identity resolved', async () => {
      const ticket = requestOne();

      const res = await request(buildApp({ agentIdentity: true }))
        .post(`/api/approvals/${ticket.approvalId}/deny`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
    });

    it('403s a caller whose agent token did NOT resolve — a revoked agent is still an agent', async () => {
      const ticket = requestOne();

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .set(AGENT_IDENTITY_HEADER, 'a-revoked-or-bogus-token')
        .send();

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
      expect(approvals.consume(ticket.token, BINDING).outcome).toBe('pending');
    });

    it('403s the requester: holding the approval token means you asked, not that you decide', async () => {
      const ticket = requestOne();

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .set(APPROVAL_TOKEN_HEADER, ticket.token)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('REQUESTER_CANNOT_DECIDE');
      expect(approvals.consume(ticket.token, BINDING).outcome).toBe('pending');
    });

    it('403s a denial from the requester too — a token holder decides nothing', async () => {
      const ticket = requestOne();

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/deny`)
        .set(APPROVAL_TOKEN_HEADER, ticket.token)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('REQUESTER_CANNOT_DECIDE');
    });

    it('still lets an agent read what is pending — only deciding is blocked', async () => {
      requestOne();

      const res = await request(buildApp({ agentIdentity: true })).get('/api/approvals/pending');

      expect(res.status).toBe(200);
      expect(res.body.approvals).toHaveLength(1);
    });

    describe('with login enabled', () => {
      it('401s a caller that sessionGate did not authenticate', async () => {
        const ticket = requestOne();

        const res = await request(buildApp({ loginEnabled: true }))
          .post(`/api/approvals/${ticket.approvalId}/grant`)
          .send();

        expect(res.status).toBe(401);
        expect(res.body.code).toBe('AUTH_REQUIRED');
        expect(approvals.consume(ticket.token, BINDING).outcome).toBe('pending');
      });

      it('lets a signed-in person decide, and records who', async () => {
        const ticket = requestOne();

        const res = await request(
          buildApp({ loginEnabled: true, user: { userId: 'user_123', credential: 'cookie' } })
        )
          .post(`/api/approvals/${ticket.approvalId}/grant`)
          .send();

        expect(res.status).toBe(200);
        expect(approvals.consume(ticket.token, BINDING).outcome).toBe('granted');
        expect(emitted).toEqual([
          {
            eventType: 'approval.granted',
            metadata: { posture: 'signed-in-operator', outcome: 'granted' },
          },
        ]);
      });

      it('still refuses an authenticated caller that presents an agent identity', async () => {
        const ticket = requestOne();

        const res = await request(
          buildApp({
            loginEnabled: true,
            user: { userId: 'user_123', credential: 'cookie' },
            agentIdentity: true,
          })
        )
          .post(`/api/approvals/${ticket.approvalId}/grant`)
          .send();

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
      });

      it('refuses a plain grant from a per-user API key, and leaves it pending (DOR-474)', async () => {
        // The residual `decision-authority.ts` named. An agent legitimately holds
        // this credential, so accepting it here let the caller that ASKED for the
        // approval answer it. `standing: true` was never the only way in.
        const ticket = requestOne();

        const res = await request(
          buildApp({ loginEnabled: true, user: { userId: 'user_program', credential: 'api-key' } })
        )
          .post(`/api/approvals/${ticket.approvalId}/grant`)
          .send();

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('operator_cookie_required');
        expect(approvals.consume(ticket.token, BINDING).outcome).toBe('pending');
        expect(emitted, 'a refused decision writes no Activity record').toEqual([]);
      });

      it('refuses a deny from a per-user API key, so an agent cannot bury the card', async () => {
        const ticket = requestOne();

        const res = await request(
          buildApp({ loginEnabled: true, user: { userId: 'user_program', credential: 'api-key' } })
        )
          .post(`/api/approvals/${ticket.approvalId}/deny`)
          .send({ reason: 'nothing to see here' });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('operator_cookie_required');
        expect(approvals.consume(ticket.token, BINDING).outcome).toBe('pending');
      });

      it('still lets a key holder READ what is pending and what is live', async () => {
        // Deliberately unchanged. The bar is on ANSWERING, and widening it to the
        // reads would be a different decision than DOR-474 asked for. Pinned so
        // that a later "harden the whole router" change has to argue for it.
        const keyApp = buildApp({
          loginEnabled: true,
          user: { userId: 'user_program', credential: 'api-key' },
        });
        requestOne();

        expect((await request(keyApp).get('/api/approvals/pending')).status).toBe(200);
        expect((await request(keyApp).get('/api/approvals/grants')).status).toBe(200);
      });

      it('still lets a key holder END a standing permission', async () => {
        // Also unchanged, for the reason the route already gives: ending a
        // permission NARROWS what an agent may do. A bar here would be a refusal
        // that makes DorkOS less safe, not more.
        const row = grants.create({
          agentPath: AGENT_IDENTITY.agentPath,
          capabilityId: 'marketplace.uninstall',
          windowMinutes: 480,
          grantedBy: 'user_owner',
          posture: 'signed-in-operator',
        });

        const res = await request(
          buildApp({ loginEnabled: true, user: { userId: 'user_program', credential: 'api-key' } })
        ).delete(`/api/approvals/grants/${row.id}`);

        expect(res.status).toBe(200);
        expect(grants.list()).toEqual([]);
      });
    });

    describe('with login disabled (the default posture)', () => {
      it('answers both ways with no credential at all, because nobody has a cookie here', async () => {
        // The half of DOR-474 that must NOT change. With login off there is no
        // cookie for the person in the cockpit either, so a bar that applied in this
        // posture would make every approval unanswerable — a worse bug than the one
        // it closes. This is the test that catches that mistake.
        const yes = requestOne();
        const no = requestOne();

        expect(
          (await request(app).post(`/api/approvals/${yes.approvalId}/grant`).send()).status
        ).toBe(200);
        expect(
          (await request(app).post(`/api/approvals/${no.approvalId}/deny`).send()).status
        ).toBe(200);
        expect(approvals.consume(yes.token, BINDING).outcome).toBe('granted');
      });

      it('records the decision as local-trust, so an unverifiable yes is still visible', async () => {
        const ticket = requestOne();

        await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send();

        expect(emitted).toEqual([
          {
            eventType: 'approval.granted',
            metadata: { posture: 'local-trust', outcome: 'granted' },
          },
        ]);
      });

      it('records a refusal too', async () => {
        const ticket = requestOne();

        await request(app).post(`/api/approvals/${ticket.approvalId}/deny`).send();

        expect(emitted.map((e) => e.eventType)).toEqual(['approval.denied']);
      });

      it('writes no Activity record for a decision it refused', async () => {
        const ticket = requestOne();

        await request(buildApp({ agentIdentity: true }))
          .post(`/api/approvals/${ticket.approvalId}/grant`)
          .send();

        expect(emitted).toEqual([]);
      });
    });
  });

  describe('POST /:id/grant { standing: true } — accepted, and refused (DOR-501)', () => {
    /** A person signed in to the cockpit, which is the only caller that qualifies. */
    const COOKIE_USER = { userId: 'user_owner', credential: 'cookie' as const };

    /** Ask for approval WITH an identity, so the card records an agent path. */
    function requestIdentified() {
      return approvals.request({
        ...BINDING,
        summary: 'Uninstall "sentry-monitor"',
        requestedBy: 'dorkbot',
        requestedByPath: AGENT_IDENTITY.agentPath,
      });
    }

    it('refuses a header-stripping caller, even though it may DECIDE the approval', async () => {
      // The whole point of the second bar. This caller clears
      // `resolveDecisionAuthority` — it presents no agent header and no approval
      // token — and it is exactly the caller the reproduced chain used. Deciding
      // once is a bounded effect; a standing permission would not be.
      const ticket = requestIdentified();
      const res = await request(buildApp({ loginEnabled: false }))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: true });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('standing_grants_require_login');
      expect(grants.list()).toEqual([]);
    });

    it('refuses a caller holding a per-user API key rather than a session', async () => {
      const ticket = requestIdentified();
      const res = await request(
        buildApp({ loginEnabled: true, user: { userId: 'user_program', credential: 'api-key' } })
      )
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: true });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('operator_cookie_required');
      expect(grants.list()).toEqual([]);
    });

    it('checks the cookie bar BEFORE the master switch', async () => {
      // Ordering matters. A caller that cannot open a permission in ANY posture
      // must not be told "turn the feature on first", which reads as an invitation
      // and would leak whether the switch is set to a caller that has no business
      // knowing.
      const withLoginOff = await request(buildApp({ loginEnabled: false, standingGrants: true }))
        .post(`/api/approvals/${requestIdentified().approvalId}/grant`)
        .send({ standing: true });
      expect(withLoginOff.body.code).toBe('standing_grants_require_login');

      const withApiKey = await request(
        buildApp({
          loginEnabled: true,
          standingGrants: true,
          user: { userId: 'user_program', credential: 'api-key' },
        })
      )
        .post(`/api/approvals/${requestIdentified().approvalId}/grant`)
        .send({ standing: true });
      expect(withApiKey.body.code).toBe('operator_cookie_required');
    });

    it('refuses a signed-in person while the master switch is off', async () => {
      const ticket = requestIdentified();
      const res = await request(buildApp({ loginEnabled: true, user: COOKIE_USER }))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: true });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STANDING_GRANTS_DISABLED');
      expect(grants.list()).toEqual([]);
    });

    it('refuses an approval nobody identified themselves for', async () => {
      // A permission keys on the agent path. An anonymous request has none, so
      // there is nothing to stop asking ABOUT — and keying it on the display label
      // would key it on caller-supplied text two agents can share.
      const anonymous = approvals.request({ ...BINDING, summary: 'Uninstall "sentry-monitor"' });

      const res = await request(
        buildApp({ loginEnabled: true, standingGrants: true, user: COOKIE_USER })
      )
        .post(`/api/approvals/${anonymous.approvalId}/grant`)
        .send({ standing: true });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('APPROVAL_HAS_NO_AGENT');
      expect(grants.list()).toEqual([]);
    });

    it('says on the card whether it can become a permission at all', async () => {
      // The one bit a surface needs, and the reason it exists: `requestedBy` is SET
      // on the marketplace confirmation rows, which are exactly the ones that carry
      // no agent path — so a button drawn from `requestedBy` would appear precisely
      // where pressing it is refused.
      requestIdentified();
      approvals.request({ ...BINDING, summary: 'Uninstall "other"', requestedBy: 'a label' });

      const res = await request(app).get('/api/approvals/pending');

      const cards = res.body.approvals as { requestedBy?: string; hasAgentPath: boolean }[];
      expect(cards).toHaveLength(2);
      expect(cards.map((c) => c.hasAgentPath)).toEqual([true, false]);
      // Both carry a label, so the label cannot be the signal.
      expect(cards.every((c) => typeof c.requestedBy === 'string')).toBe(true);
    });

    it('never projects the requestedByPath column onto the card', async () => {
      // The precise claim, and the only one that holds: the COLUMN a permission is
      // keyed on is not part of the card. `hasAgentPath` says whether there is one
      // without saying what it is.
      requestIdentified();

      const res = await request(app).get('/api/approvals/pending');

      expect(res.body.approvals[0].hasAgentPath).toBe(true);
      expect(res.body.approvals[0]).not.toHaveProperty('requestedByPath');
      expect(JSON.stringify(res.body)).not.toContain(AGENT_IDENTITY.agentPath);
    });

    it('does carry the path inside the LABEL when an agent set no display name', async () => {
      // The edge the assertion above must not be read as covering. `requestedBy` is
      // built from `displayName || agentPath`, and `agent-token-env.ts` falls back to
      // the path when the name is blank — so the label can contain it. Documented
      // rather than asserted away, because the test above passes only because its
      // fixture has a real display name, and a reader deserves to know that.
      approvals.request({
        ...BINDING,
        summary: 'Uninstall "sentry-monitor"',
        requestedBy: AGENT_IDENTITY.agentPath,
        requestedByPath: AGENT_IDENTITY.agentPath,
      });

      const res = await request(app).get('/api/approvals/pending');

      expect(res.body.approvals[0].requestedBy).toContain(AGENT_IDENTITY.agentPath);
    });

    it('says both halves when the yes was recorded but the permission was not', async () => {
      // The two writes are not one transaction. A bare 500 would leave the caller
      // unable to tell this apart from "nothing happened", and retrying would answer
      // 409 — which reads like the permission exists.
      const ticket = requestIdentified();
      vi.spyOn(grants, 'create').mockImplementation(() => {
        throw new Error('the database went away');
      });

      const res = await request(
        buildApp({ loginEnabled: true, standingGrants: true, user: COOKIE_USER })
      )
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: true });

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('STANDING_PERMISSION_NOT_RECORDED');
      expect(res.body.outcome).toBe('granted');
      // The safe half stands: the one action the person allowed still runs.
      expect(approvals.consume(ticket.token, BINDING).outcome).toBe('granted');
      expect(grants.list()).toEqual([]);
    });

    it('404s a standing request for an approval that does not exist', async () => {
      const res = await request(
        buildApp({ loginEnabled: true, standingGrants: true, user: COOKIE_USER })
      )
        .post('/api/approvals/01JQQQQQQQQQQQQQQQQQQQQQQQ/grant')
        .send({ standing: true });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('UNKNOWN_APPROVAL');
    });

    it('does not quietly fall back to a plain grant', async () => {
      // Refusing is not ignoring, and this is the assertion that tells them
      // apart. An ignored flag would leave the approval GRANTED and the caller
      // believing it also got a permission.
      const ticket = requestIdentified();
      await request(buildApp({ loginEnabled: true, user: COOKIE_USER }))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: true })
        .expect(409);

      expect(
        approvals.consume(ticket.token, BINDING).outcome,
        'the approval must still be pending, not quietly granted'
      ).toBe('pending');
      expect(emitted).toEqual([]);
    });

    it('opens a permission for a signed-in person, and says exactly what it covers', async () => {
      const ticket = requestIdentified();
      const res = await request(
        buildApp({ loginEnabled: true, standingGrants: true, user: COOKIE_USER })
      )
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: true });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('granted');
      expect(res.body.standingPermission).toEqual({
        grantId: expect.any(String),
        agentPath: AGENT_IDENTITY.agentPath,
        agentLabel: 'dorkbot',
        capabilityId: 'marketplace.uninstall',
        capabilityTitle: 'Uninstall a marketplace package',
        expiresAt: expect.any(String),
      });

      // The one-time yes happened too: a caller asked for both and got both.
      expect(approvals.consume(ticket.token, BINDING).outcome).toBe('granted');

      // Who opened it, when, and under which posture are recorded — in the row and
      // in the Activity event, which is where an audit question belongs. They are
      // deliberately absent from the response above, where nothing renders them.
      const live = grants.list();
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        id: res.body.standingPermission.grantId,
        grantedBy: COOKIE_USER.userId,
        posture: 'signed-in-operator',
        sourceApprovalId: ticket.approvalId,
      });
    });

    it('sends nothing about who opened it, and no raw account id', async () => {
      // The response is read by an agent under `local-trust` (see the note on
      // `GET /grants`), so it carries what the cockpit renders and nothing else.
      const ticket = requestIdentified();
      const res = await request(
        buildApp({ loginEnabled: true, standingGrants: true, user: COOKIE_USER })
      )
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: true });

      expect(Object.keys(res.body.standingPermission).sort()).toEqual([
        'agentLabel',
        'agentPath',
        'capabilityId',
        'capabilityTitle',
        'expiresAt',
        'grantId',
      ]);
      expect(JSON.stringify(res.body)).not.toContain(COOKIE_USER.userId);
    });

    it('bounds the window by the setting, counted from now', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
      const ticket = requestIdentified();

      const res = await request(
        buildApp({ loginEnabled: true, standingGrants: true, user: COOKIE_USER })
      )
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: true });

      // 480 minutes is what `buildApp` reports for `trustWindowMinutes`.
      expect(res.body.standingPermission.expiresAt).toBe('2026-07-26T20:00:00.000Z');
      expect(grants.list()[0].grantedAt).toBe('2026-07-26T12:00:00.000Z');
    });

    it('records both the one-time yes and the permission in the Activity feed', async () => {
      const ticket = requestIdentified();
      await request(buildApp({ loginEnabled: true, standingGrants: true, user: COOKIE_USER }))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: true });

      expect(emitted.map((e) => e.eventType)).toEqual([
        'approval.granted',
        'approval.grant_created',
      ]);
      expect(emitted[1].metadata).toMatchObject({
        posture: 'signed-in-operator',
        agentPath: AGENT_IDENTITY.agentPath,
        capabilityId: 'marketplace.uninstall',
      });
    });

    it('replaces a live permission for the same pair rather than stacking one', async () => {
      // Answering the same question again EXTENDS. Accumulating would give a person
      // a list with duplicates in it and no way to tell which one is doing the work.
      const app = buildApp({ loginEnabled: true, standingGrants: true, user: COOKIE_USER });
      const first = requestIdentified();
      await request(app).post(`/api/approvals/${first.approvalId}/grant`).send({ standing: true });
      const second = requestIdentified();
      await request(app).post(`/api/approvals/${second.approvalId}/grant`).send({ standing: true });

      expect(grants.list()).toHaveLength(1);
      expect(grants.list()[0].sourceApprovalId).toBe(second.approvalId);
    });

    it('leaves an ordinary grant untouched', async () => {
      // Nothing changes for anyone who does not send the flag: a body without it,
      // and an absent body, are both a plain one-time yes.
      const ticket = requestIdentified();
      const res = await request(buildApp({ loginEnabled: true, user: COOKIE_USER }))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        approvalId: ticket.approvalId,
        outcome: 'granted',
      });
      expect(approvals.consume(ticket.token, BINDING).outcome).toBe('granted');
    });

    it('treats standing: false as an ordinary grant', async () => {
      const ticket = requestIdentified();
      const res = await request(buildApp({ loginEnabled: true, user: COOKIE_USER }))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: false });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('granted');
    });

    it('rejects a malformed standing field rather than guessing', async () => {
      const ticket = requestIdentified();
      const res = await request(buildApp({ loginEnabled: true, user: COOKIE_USER }))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: 'yes please' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_GRANT_BODY');
    });
  });

  describe('GET /grants and DELETE /grants/:id — finding one again, and ending it (DOR-501)', () => {
    /** Seed a permission through the store, which is how Settings will list one. */
    function seed(capabilityId = 'marketplace.uninstall') {
      return grants.create({
        agentPath: AGENT_IDENTITY.agentPath,
        capabilityId,
        grantedBy: 'user_owner',
        posture: 'signed-in-operator',
        windowMinutes: 480,
      });
    }

    it('returns an empty list when nothing is live', async () => {
      const res = await request(app).get('/api/approvals/grants');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ grants: [] });
    });

    it('names the agent and the action, so a person can recognize what they granted', async () => {
      const row = seed();

      const res = await request(app).get('/api/approvals/grants');

      expect(res.body.grants).toEqual([
        {
          grantId: row.id,
          agentPath: AGENT_IDENTITY.agentPath,
          agentLabel: 'dorkbot',
          capabilityId: 'marketplace.uninstall',
          capabilityTitle: 'Uninstall a marketplace package',
          expiresAt: row.expiresAt,
        },
      ]);
    });

    it('names a hand-registered MCP tool too, which the registry knows nothing about', async () => {
      // Today these tools are most of what can actually be granted, so leaving them
      // as raw ids would break the promise that this list is one a person recognizes.
      seed('tasks_delete');

      const res = await request(app).get('/api/approvals/grants');

      expect(res.body.grants[0].capabilityTitle).toBe('Delete a scheduled task');
    });

    it('refuses an agent that names itself, so no agent can read its own free passes', async () => {
      // Unlike a pending card, this list is PROSPECTIVE: it says which irreversible
      // action goes through silently right now and when the window shuts. So it is
      // authorized like deciding, not like reading a card.
      seed();

      const res = await request(buildApp({ agentIdentity: true })).get('/api/approvals/grants');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
    });

    it('refuses the caller holding an approval token', async () => {
      seed();

      const res = await request(app)
        .get('/api/approvals/grants')
        .set(APPROVAL_TOKEN_HEADER, 'some-approval-token');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('REQUESTER_CANNOT_DECIDE');
    });

    it('falls back to the capability id when nothing can name the action', async () => {
      const row = seed('some.unregistered_capability');

      const res = await request(app).get('/api/approvals/grants');

      expect(res.body.grants).toHaveLength(1);
      expect(res.body.grants[0]).toMatchObject({
        grantId: row.id,
        capabilityTitle: 'some.unregistered_capability',
      });
    });

    it('hides a permission whose window has closed, without waiting for a sweep', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
      seed();
      vi.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));

      const res = await request(app).get('/api/approvals/grants');

      expect(res.body.grants).toEqual([]);
    });

    it('ends one permission and records it', async () => {
      const row = seed();

      const res = await request(app).delete(`/api/approvals/grants/${row.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, grantId: row.id });
      expect(grants.list()).toEqual([]);
      expect(emitted.map((e) => e.eventType)).toEqual(['approval.grant_revoked']);
      expect(emitted[0].metadata).toMatchObject({ grantId: row.id });
    });

    it('404s a second click, so ending one cannot be recorded twice', async () => {
      const row = seed();
      await request(app).delete(`/api/approvals/grants/${row.id}`).expect(200);

      const again = await request(app).delete(`/api/approvals/grants/${row.id}`);

      expect(again.status).toBe(404);
      expect(again.body.code).toBe('UNKNOWN_STANDING_PERMISSION');
      expect(emitted.map((e) => e.eventType)).toEqual(['approval.grant_revoked']);
    });

    it('refuses an agent that names itself, so nothing can end a permission but a person', async () => {
      const row = seed();

      const res = await request(buildApp({ agentIdentity: true })).delete(
        `/api/approvals/grants/${row.id}`
      );

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
      expect(grants.list()).toHaveLength(1);
    });
  });

  it('removes an approval from the pending list once it is decided', async () => {
    const ticket = requestOne();
    await request(app).post(`/api/approvals/${ticket.approvalId}/deny`).send();

    const res = await request(app).get('/api/approvals/pending');
    expect(res.body.approvals).toEqual([]);
  });
});

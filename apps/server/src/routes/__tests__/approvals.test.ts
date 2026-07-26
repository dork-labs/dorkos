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
      createApprovalsRouter(approvals, {
        activity,
        isLoginEnabled: () => options.loginEnabled === true,
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

        const res = await request(buildApp({ loginEnabled: true, user: { userId: 'user_123' } }))
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
          buildApp({ loginEnabled: true, user: { userId: 'user_123' }, agentIdentity: true })
        )
          .post(`/api/approvals/${ticket.approvalId}/grant`)
          .send();

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
      });
    });

    describe('with login disabled (the default posture)', () => {
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

    it('checks the cookie bar BEFORE the not-yet-enforced refusal', async () => {
      // Ordering matters: the bar has to be live and observable NOW, so the phase
      // that adds enforcement replaces the refusal beneath it and nothing else.
      // If the not-yet-enforced answer came first it would mask the bar, and the
      // bar would ship untested under a refusal that is going away.
      const withLoginOff = await request(buildApp({ loginEnabled: false }))
        .post(`/api/approvals/${requestIdentified().approvalId}/grant`)
        .send({ standing: true });
      expect(withLoginOff.body.code).toBe('standing_grants_require_login');

      const withApiKey = await request(
        buildApp({ loginEnabled: true, user: { userId: 'user_program', credential: 'api-key' } })
      )
        .post(`/api/approvals/${requestIdentified().approvalId}/grant`)
        .send({ standing: true });
      expect(withApiKey.body.code).toBe('operator_cookie_required');

      // Neither caller ever saw the refusal that is scheduled for deletion.
      for (const res of [withLoginOff, withApiKey]) {
        expect(res.body.code).not.toBe('STANDING_GRANTS_NOT_YET_ENFORCED');
      }
    });

    it('refuses a signed-in person too, because nothing enforces one yet', async () => {
      // Honest rather than encouraging. A recorded permission would report a
      // success that changes nothing: the agent would keep asking every time.
      const ticket = requestIdentified();
      const res = await request(buildApp({ loginEnabled: true, user: COOKIE_USER }))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ standing: true });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STANDING_GRANTS_NOT_YET_ENFORCED');
      expect(grants.list()).toEqual([]);
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

  it('removes an approval from the pending list once it is decided', async () => {
    const ticket = requestOne();
    await request(app).post(`/api/approvals/${ticket.approvalId}/deny`).send();

    const res = await request(app).get('/api/approvals/pending');
    expect(res.body.approvals).toEqual([]);
  });
});

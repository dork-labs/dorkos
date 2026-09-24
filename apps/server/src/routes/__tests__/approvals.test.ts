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
import type { Server } from 'node:http';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  ApprovalService,
  APPROVAL_TTL_MS,
  hashApprovalInput,
} from '../../services/core/approvals/index.js';
import { APPROVAL_TOKEN_HEADER } from '../../services/core/capabilities/index.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { createApprovalsRouter } from '../approvals.js';
import { createPermissionWorld } from '../../services/core/permissions/__tests__/permission-fixtures.js';
import { UPGRADE_WRITER } from '../../services/core/permissions/permission-history.js';

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
  const target = swappableServer();
  let approvals: ApprovalService;
  let world: ReturnType<typeof createPermissionWorld>;
  let app: Server;
  let emitted: {
    eventType: string;
    summary?: string;
    actorLabel?: string;
    metadata?: Record<string, unknown> | null;
  }[];

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
  ): Server {
    const built = express();
    built.use(express.json());
    built.use((_req, res, next) => {
      if (options.agentIdentity) res.locals.agentIdentity = AGENT_IDENTITY;
      if (options.user) res.locals.user = options.user;
      next();
    });
    const activity = {
      emit: async (event: {
        eventType: string;
        summary?: string;
        actorLabel?: string;
        metadata?: Record<string, unknown> | null;
      }) => {
        emitted.push({
          eventType: event.eventType,
          summary: event.summary,
          actorLabel: event.actorLabel,
          metadata: event.metadata,
        });
      },
    } as unknown as ActivityService;
    built.use(
      '/api/approvals',
      createApprovalsRouter(approvals, {
        activity,
        permissions: world.service,
        isLoginEnabled: () => options.loginEnabled === true,
        describeCapability: (id) =>
          id === 'marketplace.uninstall'
            ? { title: 'Uninstall a marketplace package' }
            : id === 'rooms.create'
              ? { title: 'Open a room' }
              : undefined,
      })
    );
    return target.mount(built);
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
    world = createPermissionWorld({
      preset: 'full',
      agents: [
        {
          id: 'agent-dorkbot',
          name: 'dorkbot',
          displayName: 'DorkBot',
          projectPath: AGENT_IDENTITY.agentPath,
        },
      ],
    });
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
      expect(res.body).toEqual({
        ok: true,
        approvalId: ticket.approvalId,
        outcome: 'granted',
        answer: 'once',
      });
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
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
          eventType: 'permission.answered',
          actorLabel: 'You (signed in as user_123)',
          metadata: { answer: 'once', posture: 'signed-in-operator' },
        });
        expect(emitted[0]!.summary).toMatch(/^You allowed dorkbot/);
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
        // approval answer it.
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

      it('still lets a key holder READ what is pending', async () => {
        // Deliberately unchanged. The bar is on ANSWERING, and widening it to the
        // reads would be a different decision than DOR-474 asked for. Pinned so
        // that a later "harden the whole router" change has to argue for it.
        const keyApp = buildApp({
          loginEnabled: true,
          user: { userId: 'user_program', credential: 'api-key' },
        });
        requestOne();

        expect((await request(keyApp).get('/api/approvals/pending')).status).toBe(200);
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
            eventType: 'permission.answered',
            actorLabel: 'Someone on this computer',
            summary:
              'Someone on this computer allowed dorkbot to run "Uninstall a marketplace package" once',
            metadata: {
              action: 'marketplace.uninstall',
              area: null,
              answer: 'once',
              approvalId: ticket.approvalId,
              blockedRequest: false,
              posture: 'local-trust',
            },
          },
        ]);
      });

      it('records a refusal too, as exactly one answer', async () => {
        const ticket = requestOne();

        await request(app).post(`/api/approvals/${ticket.approvalId}/deny`).send();

        expect(emitted.map((e) => e.eventType)).toEqual(['permission.answered']);
        expect(emitted[0]!.metadata).toMatchObject({ answer: 'deny' });
        expect(emitted[0]!.summary).toBe(
          'Someone on this computer said no to dorkbot running "Uninstall a marketplace package"'
        );
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

  describe("POST /:id/grant { answer: 'always' } (spec agent-permissions D7)", () => {
    /** DorkBot asks for `rooms.create`, as the gate records an Ask in the Rooms area. */
    function requestRoom(area: 'rooms' | 'safety' | null = 'rooms', identified = true) {
      return approvals.request({
        capabilityId: 'rooms.create',
        inputHash: hashApprovalInput({ title: 'proj-lunar' }),
        summary: '"DorkBot" wants to run "Open a room" with title: "proj-lunar"',
        requestedBy: 'DorkBot',
        ...(identified ? { requestedByPath: AGENT_IDENTITY.agentPath } : {}),
        area,
      });
    }

    it('says on the card whether Always allow is offered', async () => {
      requestRoom();
      requestRoom('safety');
      requestRoom(null);
      requestRoom('rooms', false);

      const res = await request(app).get('/api/approvals/pending');
      expect(res.body.approvals.map((a: { alwaysOffered: boolean }) => a.alwaysOffered)).toEqual([
        true,
        false,
        false,
        false,
      ]);
      // The raw path never leaves through the card, only the fact of it.
      expect(res.text).not.toContain(AGENT_IDENTITY.agentPath);
    });

    it('grants and writes the action override, with one answer and one change', async () => {
      const ticket = requestRoom();

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ answer: 'always' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        approvalId: ticket.approvalId,
        outcome: 'granted',
        answer: 'always',
      });
      expect(world.agents.get('agent-dorkbot')?.permissions).toEqual({
        actions: { 'rooms.create': 'allowed' },
      });
      expect(emitted.map((e) => e.eventType)).toEqual(['permission.answered']);
      expect(emitted[0]!.metadata).toMatchObject({
        agentId: 'agent-dorkbot',
        action: 'rooms.create',
        area: 'rooms',
        answer: 'always',
      });
      expect(emitted[0]!.summary).toBe(
        'Someone on this computer allowed DorkBot to run "Open a room" from now on'
      );
      // The setting's own audit line, through the one permission write owner.
      const changed = world.events.filter((e) => e.eventType === 'permission.changed');
      expect(changed).toHaveLength(1);
      expect(changed[0]!.metadata).toMatchObject({
        surface: 'request-card',
        attribution: 'local-trust',
        approvalId: ticket.approvalId,
        changes: [
          {
            key: { kind: 'action', action: 'rooms.create', area: 'rooms' },
            before: null,
            after: 'allowed',
          },
        ],
      });
    });

    it('writes the setting BEFORE the verdict fans out', async () => {
      const ticket = requestRoom();
      const order: string[] = [];
      const setAgent = world.service.setAgent.bind(world.service);
      vi.spyOn(world.service, 'setAgent').mockImplementation(async (...args) => {
        order.push('setting');
        return setAgent(...args);
      });
      vi.mocked(eventFanOut.broadcast).mockImplementation((name) => {
        if (name === 'approval_resolved') order.push('verdict');
      });

      await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ answer: 'always' });

      expect(order).toEqual(['setting', 'verdict']);
    });

    it.each([
      ['a floor area', () => requestRoom('safety')],
      ['an action with no area', () => requestRoom(null)],
      ['a request with no agent path', () => requestRoom('rooms', false)],
    ])('409s on %s, and grants nothing', async (_name, make) => {
      const ticket = make();

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ answer: 'always' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ALWAYS_NOT_OFFERED');
      expect(approvals.getPending(ticket.approvalId)).toBeDefined();
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
      expect(world.agents.get('agent-dorkbot')?.permissions).toBeUndefined();
      expect(emitted).toEqual([]);
    });

    describe('when another answer wins the card while the setting is saved', () => {
      /** Let the real write land, then have a Deny arrive before the grant. */
      function denyDuringWrite(ticketId: string, failUndo = false) {
        const setAgent = world.service.setAgent.bind(world.service);
        vi.spyOn(world.service, 'setAgent').mockImplementation(async (...args) => {
          if (args[1].surface === 'undo' && failUndo) throw new Error('disk full');
          const changes = await setAgent(...args);
          if (args[1].surface === 'request-card') approvals.deny(ticketId);
          return changes;
        });
      }

      it('puts the setting back, records both writes, and records no yes', async () => {
        const ticket = requestRoom();
        denyDuringWrite(ticket.approvalId);

        const res = await request(app)
          .post(`/api/approvals/${ticket.approvalId}/grant`)
          .send({ answer: 'always' });

        expect(res.status).toBe(409);
        expect(world.agents.get('agent-dorkbot')?.permissions?.actions?.['rooms.create']).toBe(
          undefined
        );
        const changed = world.events.filter((e) => e.eventType === 'permission.changed');
        expect(changed.map((e) => e.metadata)).toMatchObject([
          { surface: 'request-card', approvalId: ticket.approvalId },
          {
            surface: 'undo',
            approvalId: ticket.approvalId,
            changes: [{ before: 'allowed', after: null }],
          },
        ]);
        // The yes did not happen, so no answer says it did.
        expect(emitted).toEqual([]);
      });

      it('restores the value the action had before, not the default', async () => {
        world.agents.get('agent-dorkbot')!.permissions = { actions: { 'rooms.create': 'ask' } };
        const ticket = requestRoom();
        denyDuringWrite(ticket.approvalId);

        await request(app)
          .post(`/api/approvals/${ticket.approvalId}/grant`)
          .send({ answer: 'always' });

        expect(world.agents.get('agent-dorkbot')?.permissions).toEqual({
          actions: { 'rooms.create': 'ask' },
        });
      });

      it('says so plainly when the setting could not be put back', async () => {
        const ticket = requestRoom();
        denyDuringWrite(ticket.approvalId, true);

        const res = await request(app)
          .post(`/api/approvals/${ticket.approvalId}/grant`)
          .send({ answer: 'always' });

        expect(res.status).toBe(500);
        expect(res.body.code).toBe('ALWAYS_ALLOW_NOT_UNDONE');
        expect(emitted).toEqual([]);
      });
    });

    it('never takes back a change somebody else made in the gap', async () => {
      // The undo is a compare-and-set: the action goes back only while it still
      // holds what this answer wrote.
      const ticket = requestRoom();
      const setAgent = world.service.setAgent.bind(world.service);
      vi.spyOn(world.service, 'setAgent').mockImplementation(async (...args) => {
        const changes = await setAgent(...args);
        if (args[1].surface === 'request-card') {
          approvals.deny(ticket.approvalId);
          await setAgent(
            'agent-dorkbot',
            { actions: { 'rooms.create': 'ask' }, surface: 'agent-page' },
            UPGRADE_WRITER
          );
        }
        return changes;
      });

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ answer: 'always' });

      expect(res.status).toBe(409);
      expect(world.agents.get('agent-dorkbot')?.permissions?.actions?.['rooms.create']).toBe('ask');
      const surfaces = world.events
        .filter((e) => e.eventType === 'permission.changed')
        .map((e) => (e.metadata as { surface: string }).surface);
      expect(surfaces).toEqual(['request-card', 'agent-page']);
    });

    it('runs two Always allows on one card one after the other, so the loser undoes nothing', async () => {
      // Side by side, both would read "not set" before either wrote; the one
      // whose yes lost would then take back the winner's setting. Each call
      // waits here for the other (or a short while, when it never arrives
      // because the two are already running one after the other).
      const ticket = requestRoom();
      const setAgent = world.service.setAgent.bind(world.service);
      let arrived = 0;
      let bothHere!: () => void;
      const barrier = new Promise<void>((resolve) => (bothHere = resolve));
      vi.spyOn(world.service, 'setAgent').mockImplementation(async (...args) => {
        if (args[1].surface === 'request-card') {
          if (++arrived === 2) bothHere();
          await Promise.race([barrier, new Promise((r) => setTimeout(r, 100))]);
        }
        return setAgent(...args);
      });

      const answer = () =>
        request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send({ answer: 'always' });
      const results = await Promise.all([answer(), answer()]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(world.agents.get('agent-dorkbot')?.permissions).toEqual({
        actions: { 'rooms.create': 'allowed' },
      });
      const surfaces = world.events
        .filter((e) => e.eventType === 'permission.changed')
        .map((e) => (e.metadata as { surface: string }).surface);
      expect(surfaces).toEqual(['request-card']);
      expect(emitted.map((e) => e.eventType)).toEqual(['permission.answered']);
    });

    it('writes no setting for a card that was already answered', async () => {
      const ticket = requestRoom();
      approvals.deny(ticket.approvalId);

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ answer: 'always' });

      expect(res.status).toBe(409);
      expect(world.agents.get('agent-dorkbot')?.permissions).toBeUndefined();
    });

    it('still refuses an agent, whatever the answer', async () => {
      const ticket = requestRoom();

      const res = await request(buildApp({ agentIdentity: true }))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ answer: 'always' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
      expect(world.agents.get('agent-dorkbot')?.permissions).toBeUndefined();
    });

    it('still refuses a per-user API key under login', async () => {
      const ticket = requestRoom();

      const res = await request(
        buildApp({ loginEnabled: true, user: { userId: 'user_program', credential: 'api-key' } })
      )
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ answer: 'always' });

      expect(res.status).toBe(403);
      expect(world.agents.get('agent-dorkbot')?.permissions).toBeUndefined();
    });

    it('rejects an answer it does not know rather than guessing', async () => {
      const ticket = requestRoom();

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ answer: 'forever' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_GRANT_BODY');
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
    });

    it('treats an absent answer as once, and writes no setting', async () => {
      const ticket = requestRoom();

      const res = await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send();

      expect(res.body.answer).toBe('once');
      expect(world.agents.get('agent-dorkbot')?.permissions).toBeUndefined();
      expect(world.events.filter((e) => e.eventType === 'permission.changed')).toEqual([]);
    });
  });

  it('removes an approval from the pending list once it is decided', async () => {
    const ticket = requestOne();
    await request(app).post(`/api/approvals/${ticket.approvalId}/deny`).send();

    const res = await request(app).get('/api/approvals/pending');
    expect(res.body.approvals).toEqual([]);
  });
});

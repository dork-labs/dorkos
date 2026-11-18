/** Remote approval confirmation stays bound to one stored request. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, approvals as approvalRows } from '@dorkos/db';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService, hashApprovalInput } from '../../services/core/approvals/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { markIngress, type IngressKind } from '../../services/core/remote/ingress-mark.js';
import { resetRemotePasswordFailuresForTests } from '../../services/core/auth/step-up/remote-password-failures.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createApprovalsRoutes, type ApprovalsRouterOptions } from '../approvals.js';
import { createStepUpRoutes } from '../step-up.js';
import { setTestOwner } from './test-owner.js';
import { composeCapabilityRegistryForDocs } from '../../services/core/self-description/dorkos-registry.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type GatedAction,
} from '../../services/core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
  resolveCallPermission,
  type PermissionGatedAction,
} from '../../services/core/capabilities/permission-enforcement.js';
import {
  noteConfigPatchCard,
  resetFrontDoorCardsForTests,
} from '../../services/core/approvals/model/front-door-cards.js';

/** Remote cases registered beside the existing approvals route tests. */
export function registerApprovalStepUpCases(): void {
  describe('approval confirmation', () => {
    const target = swappableServer();
    const ORIGIN = 'http://localhost:4242';
    const PASSWORD = 'made-up confirmation password';
    let db: ReturnType<typeof createTestDb>;
    let approvals: ApprovalService;
    let events: Record<string, unknown>[];
    const remoteFailure = vi.fn(async () => undefined);
    const setAgent = vi.fn(async () => []);
    const permissions: NonNullable<ApprovalsRouterOptions['permissions']> = {
      agentByPath: (projectPath) => ({ id: 'kestrel', name: 'kestrel', projectPath }),
      setAgent,
    };

    function app(
      ingress?: IngressKind,
      sessionId = 'browser-a',
      credential: 'cookie' | 'api-key' = 'cookie'
    ) {
      return target.mount(
        honoGroupListener(
          [
            {
              path: '/api/approvals',
              routes: createApprovalsRoutes(approvals, {
                isLoginEnabled: () => true,
                permissions,
                activity: {
                  emit: async (event: Record<string, unknown>) => {
                    events.push(event);
                  },
                } as never,
              }),
            },
            {
              path: '/api/step-up',
              routes: createStepUpRoutes({
                ownerId: () => 'owner',
                remoteFailure,
                checkPassword: async (password) => (password === PASSWORD ? 'ok' : 'wrong'),
                minPasswordLength: async () => 8,
                setOwnerPassword: async () => undefined,
                trustedOrigins: () => [ORIGIN],
              }),
            },
          ],
          {
            before: async (c, next) => {
              if (ingress) markIngress(c.env.incoming, ingress);
              c.set(
                'user',
                credential === 'cookie'
                  ? {
                      userId: 'owner',
                      credential,
                      sessionId,
                      route:
                        ingress === 'own-tunnel'
                          ? 'tunnel'
                          : ingress === 'wifi'
                            ? 'wifi'
                            : ingress === 'managed'
                              ? 'managed'
                              : 'local',
                    }
                  : { userId: 'owner', credential, credentialId: 'made-up-key' }
              );
              await next();
            },
          }
        )
      );
    }

    function ask(name = 'notes') {
      return approvals.request({
        capabilityId: 'files.read',
        inputHash: hashApprovalInput({ name }),
        summary: `Read ${name}.`,
        requestedBy: 'Kestrel',
      });
    }
    const grant = (id: string, ingress?: IngressKind) =>
      request(app(ingress)).post(`/api/approvals/${id}/grant`).set('Origin', ORIGIN).send({});
    const confirm = (id: string, ingress: IngressKind = 'own-tunnel', sessionId?: string) =>
      request(app(ingress, sessionId))
        .post(`/api/step-up/${id}/password`)
        .set('Origin', ORIGIN)
        .send({ password: PASSWORD });

    beforeEach(() => {
      db = createTestDb();
      approvals = new ApprovalService(db, {
        describeCapability: () => ({ title: 'Read a file', tier: 'observe' }),
      });
      events = [];
      remoteFailure.mockClear();
      resetRemotePasswordFailuresForTests();
      setAgent.mockClear();
      resetHeldStepUpsForTests();
      vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    });
    afterEach(() => {
      resetHeldStepUpsForTests();
      vi.restoreAllMocks();
    });

    it.each(['own-tunnel', 'managed'] as const)(
      'holds a one-time answer from %s',
      async (ingress) => {
        const ticket = ask();
        const res = await grant(ticket.approvalId, ingress);
        expect(res.status).toBe(428);
        expect(res.body.code).toBe('step_up_required');
        expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
        expect(events).toEqual([]);
      }
    );

    it('refuses a remote API key instead of holding an answer for it', async () => {
      const ticket = ask();
      const res = await request(app('own-tunnel', 'browser-a', 'api-key'))
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .set('Origin', ORIGIN)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('operator_cookie_required');
      expect(res.body.heldActionId).toBeUndefined();
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
    });

    describe('Always allow on a capability card at this computer', () => {
      const alwaysCard = () =>
        approvals.request({
          capabilityId: 'rooms.create',
          inputHash: hashApprovalInput({ title: 'notes' }),
          summary: 'Open a room.',
          requestedBy: 'Kestrel',
          requestedByPath: '/made-up/kestrel',
          area: 'rooms',
        });
      const deskAlways = (id: string) =>
        request(app())
          .post(`/api/approvals/${id}/grant`)
          .set('Origin', ORIGIN)
          .send({ answer: 'always' });
      afterEach(() => setTestOwner(null));

      it('holds it once an owner exists, like the tool prompt and offers, then saves it', async () => {
        setTestOwner('owner');
        const ticket = alwaysCard();
        const held = await deskAlways(ticket.approvalId);
        expect(held.status).toBe(428);
        expect(setAgent).not.toHaveBeenCalled();
        const confirmed = await request(app())
          .post(`/api/step-up/${held.body.heldActionId}/password`)
          .set('Origin', ORIGIN)
          .send({ password: PASSWORD });
        expect(confirmed.body).toMatchObject({ ok: true, status: 200 });
        expect(setAgent).toHaveBeenCalledTimes(1);
      });

      it('saves it at once while no owner exists, with no password to ask for', async () => {
        const ticket = alwaysCard();
        const res = await deskAlways(ticket.approvalId);
        expect(res.status).toBe(200);
        expect(setAgent).toHaveBeenCalledTimes(1);
      });
    });

    describe('a permission change card at this computer (Security S1)', () => {
      const permissionCard = () =>
        approvals.request({
          capabilityId: 'permissions.change',
          inputHash: hashApprovalInput({ area: 'reach', state: 'allowed' }),
          summary: 'Allow Kestrel to reach outside services.',
          requestedBy: 'Kestrel',
        });
      const deskOnce = (id: string) =>
        request(app())
          .post(`/api/approvals/${id}/grant`)
          .set('Origin', ORIGIN)
          .send({ answer: 'once' });
      afterEach(() => setTestOwner(null));

      it('holds an Allow once once an owner exists: the change lasts, like Always allow', async () => {
        setTestOwner('owner');
        const ticket = permissionCard();
        const held = await deskOnce(ticket.approvalId);
        expect(held.status).toBe(428);
        expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
      });

      it('allows it at once while no owner exists, with no password to ask for', async () => {
        const ticket = permissionCard();
        expect((await deskOnce(ticket.approvalId)).status).toBe(200);
      });
    });

    describe('a settings card that changes a front-door setting (Security M1 on #3878)', () => {
      const settingsCard = (patch?: unknown) => {
        const ticket = approvals.request({
          capabilityId: 'operator.config_patch',
          inputHash: hashApprovalInput({ patch }),
          summary: 'Update configuration.',
          requestedBy: 'Kestrel',
        });
        if (patch !== undefined)
          noteConfigPatchCard(ticket.approvalId, 'operator.config_patch', { patch });
        return ticket;
      };
      const deskGrant = (id: string, ingress?: IngressKind) =>
        request(app(ingress))
          .post(`/api/approvals/${id}/grant`)
          .set('Origin', ORIGIN)
          .send({ answer: 'once' });
      beforeEach(() => {
        resetFrontDoorCardsForTests();
        setTestOwner('owner');
      });
      afterEach(() => setTestOwner(null));

      it('holds it at this computer too, and writes it only once confirmed', async () => {
        const ticket = settingsCard({ tunnel: { auth: { mode: 'open' } } });
        const held = await deskGrant(ticket.approvalId);
        expect(held.status).toBe(428);
        expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
        const confirmed = await request(app())
          .post(`/api/step-up/${held.body.heldActionId}/password`)
          .set('Origin', ORIGIN)
          .send({ password: PASSWORD });
        expect(confirmed.body).toMatchObject({ ok: true, status: 200 });
        expect(approvals.answerScope(ticket.approvalId)?.state).toBe('granted');
      });

      it.each([
        [undefined, { tunnel: { auth: { mode: 'open' } } }],
        ['own-tunnel', { tunnel: { auth: { mode: 'open' } } }],
        ['managed', { tunnel: { auth: { mode: 'open' } } }],
        [undefined, { mcp: { apiKey: 'made-up-key-value' } }],
        ['own-tunnel', { mcp: { apiKey: 'made-up-key-value' } }],
        ['managed', { mcp: { apiKey: 'made-up-key-value' } }],
      ] as const)(
        'holds an Allow-once of a front-door settings card (%s, %o) and writes nothing',
        async (via, patch) => {
          const ticket = settingsCard(patch);
          const held = await deskGrant(ticket.approvalId, via);
          expect(held.status).toBe(428);
          expect(held.body.heldActionId).toEqual(expect.any(String));
          expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
          expect(events).toEqual([]);
        }
      );

      it.each([
        [{ tunnel: { auth: { mode: 'open' } } }, 428],
        [{ ui: { theme: 'dark' } }, 200],
      ] as const)(
        'answers a card the real gate raised for %o with %i at this computer',
        async (patch, status) => {
          initCapabilityTierGate({ approvals });
          initPermissionGate({
            // Careful blocks Reach & secrets outright; ask, so the gate raises a card.
            readConfig: () => ({
              preset: 'careful',
              defaults: { areas: { reach: 'ask', settings: 'ask' }, actions: {} },
            }),
            readAgentPermissions: async () => undefined,
          });
          try {
            const action = composeCapabilityRegistryForDocs().capabilities.find(
              (c) => c.id === 'operator.config_patch'
            ) as unknown as GatedAction & PermissionGatedAction;
            const identity = {
              agentPath: '/made-up/kestrel',
              displayName: 'Kestrel',
              createdAt: new Date().toISOString(),
            };
            const input = { patch };
            const permission = await resolveCallPermission({
              action,
              identity,
              sessionId: 'made-up-session',
              input,
            });
            const decision = await enforceCapabilityTier({
              action,
              input,
              permission,
              identity,
              retryChannel: 'mcp-argument',
            });
            expect(decision.outcome, JSON.stringify(decision)).toBe('approval_required');
            if (decision.outcome !== 'approval_required') return;
            expect((await deskGrant(decision.payload.approvalId)).status).toBe(status);
          } finally {
            resetCapabilityTierGate();
            resetPermissionGate();
          }
        }
      );

      it('tells the desk card ahead that a front-door change asks to confirm', async () => {
        const door = settingsCard({ tunnel: { auth: { mode: 'open' } } });
        const plain = settingsCard({ ui: { theme: 'dark' } });
        const pending = await request(app()).get('/api/approvals/pending');
        const byId = (id: string) =>
          (pending.body.approvals as { approvalId: string }[]).find((a) => a.approvalId === id);
        expect(byId(door.approvalId)).toMatchObject({
          answerNeedsStepUp: true,
          answeringFrom: 'this computer',
        });
        expect(byId(plain.approvalId)).toMatchObject({ answerNeedsStepUp: false });
        expect(byId(plain.approvalId)).not.toHaveProperty('answeringFrom');
      });

      it.each([
        [{ heartbeats: { triageOnCredits: true } }, 428],
        [{ cloud: { credits: { defaults: { chat: { runsOn: 'credits' } } } } }, 428],
        [{ heartbeats: { triageOnCredits: false } }, 200],
        [{ cloud: { credits: { defaults: { chat: { runsOn: 'own-sign-in' } } } } }, 200],
      ] as const)(
        'treats a spending change %o like #3878 does: %i at this computer',
        async (patch, status) => {
          const ticket = settingsCard(patch);
          expect((await deskGrant(ticket.approvalId)).status).toBe(status);
        }
      );

      it('leaves an ordinary settings card immediate at this computer', async () => {
        const ticket = settingsCard({ ui: { theme: 'dark' } });
        const res = await deskGrant(ticket.approvalId);
        expect(res.status).toBe(200);
        expect(approvals.answerScope(ticket.approvalId)?.state).toBe('granted');
      });

      it('holds a settings card whose patch this process never saw', async () => {
        const ticket = settingsCard();
        expect((await deskGrant(ticket.approvalId)).status).toBe(428);
      });
    });

    it('keeps desk answers immediate', async () => {
      const ticket = ask();
      expect((await grant(ticket.approvalId)).status).toBe(200);
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('granted');
    });

    it.each(['own-tunnel', 'managed'] as const)(
      'holds an Always allow from %s before saving its setting',
      async (via) => {
        const ticket = approvals.request({
          capabilityId: 'rooms.create',
          inputHash: hashApprovalInput({ title: 'notes' }),
          summary: 'Open a room.',
          requestedBy: 'Kestrel',
          requestedByPath: '/made-up/kestrel',
          area: 'rooms',
        });
        const held = await request(app(via))
          .post(`/api/approvals/${ticket.approvalId}/grant`)
          .set('Origin', ORIGIN)
          .send({ answer: 'always' });
        expect(held.status).toBe(428);
        expect(setAgent).not.toHaveBeenCalled();
        expect((await confirm(held.body.heldActionId, via)).body).toMatchObject({
          ok: true,
          status: 200,
        });
        expect(setAgent).toHaveBeenCalledTimes(1);
        expect(approvals.answerScope(ticket.approvalId)?.state).toBe('granted');
      }
    );

    it('confirms the exact held request once', async () => {
      const ticket = ask();
      const held = await grant(ticket.approvalId, 'own-tunnel');
      expect(held.status).toBe(428);
      expect((await confirm(held.body.heldActionId)).body).toMatchObject({ ok: true, status: 200 });
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('granted');
      expect((await confirm(held.body.heldActionId)).status).toBe(404);
    });

    it.each(['inputHash', 'summary'] as const)('refuses a different stored %s', async (field) => {
      const ticket = ask();
      const held = await grant(ticket.approvalId, 'own-tunnel');
      expect(held.status).toBe(428);
      db.update(approvalRows)
        .set({
          [field]: field === 'inputHash' ? hashApprovalInput({ name: 'other' }) : 'Read other.',
        })
        .where(eq(approvalRows.id, ticket.approvalId))
        .run();
      const res = await confirm(held.body.heldActionId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('different-request');
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
    });

    it('keeps confirmations in the browser that asked', async () => {
      const held = await grant(ask().approvalId, 'own-tunnel');
      expect(held.status).toBe(428);
      expect((await confirm(held.body.heldActionId, 'own-tunnel', 'browser-b')).body.code).toBe(
        'not-your-action'
      );
    });

    it('a confirmation leaves a separate request waiting', async () => {
      const first = ask();
      const second = ask('other');
      const held = await grant(first.approvalId, 'own-tunnel');
      expect(held.status).toBe(428);
      await confirm(held.body.heldActionId);
      expect(approvals.answerScope(second.approvalId)?.state).toBe('pending');
    });

    it('keeps Wi-Fi’s destructive and standing refusals', async () => {
      const once = ask();
      const always = await request(app('wifi'))
        .post(`/api/approvals/${once.approvalId}/grant`)
        .set('Origin', ORIGIN)
        .send({ answer: 'always' });
      expect(always.status).toBe(403);
      expect(always.body.code).toBe('NOT_FROM_WIFI');
      db.update(approvalRows)
        .set({ tier: 'destructive' })
        .where(eq(approvalRows.id, once.approvalId))
        .run();
      expect((await grant(once.approvalId, 'wifi')).status).toBe(403);
    });

    it('allows nothing when a held yes is finished on Wi-Fi', async () => {
      const ticket = ask();
      const held = await grant(ticket.approvalId, 'own-tunnel');
      expect(held.status).toBe(428);
      // Refused by the sheet (no password over plain Wi-Fi) or by the commit's own Wi-Fi rule.
      const finished = await confirm(held.body.heldActionId, 'wifi');
      expect(finished.body.ok === true ? finished.body.result.code : finished.body.code).toMatch(
        /^(NOT_FROM_WIFI|insecure-connection)$/
      );
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
    });

    it('keeps passwords off plain-http Wi-Fi', async () => {
      const ticket = ask();
      const refused = await grant(ticket.approvalId, 'wifi');
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'NOT_FROM_WIFI',
        error: 'Answer at your computer or over Remote Access.',
      });
      expect(refused.body.heldActionId).toBeUndefined();
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
    });

    it('keeps an approval denied during confirmation denied', async () => {
      const ticket = ask();
      const held = await grant(ticket.approvalId, 'own-tunnel');
      expect(held.status).toBe(428);
      approvals.deny(ticket.approvalId);
      expect((await confirm(held.body.heldActionId)).body).toMatchObject({
        ok: true,
        status: 409,
        result: { code: 'APPROVAL_NOT_PENDING' },
      });
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('denied');
    });

    it('keeps the code stable when the waiting chat claims its verdict', async () => {
      const ticket = approvals.request({
        capabilityId: 'files.read',
        inputHash: hashApprovalInput({ name: 'notes' }),
        summary: 'Read notes.',
        requestedBy: 'Kestrel',
        requestingSession: { sessionId: 'made-up-waiting-chat', cwd: '/made-up/kestrel' },
      });
      const before = approvals.getPending(ticket.approvalId)?.requestCode;
      const held = await grant(ticket.approvalId, 'own-tunnel');
      expect(held.status).toBe(428);
      expect(approvals.claimVerdictDelivery(ticket.approvalId)).toBe(true);
      expect(approvals.getPending(ticket.approvalId)?.requestCode).toBe(before);
      expect((await confirm(held.body.heldActionId)).body).toMatchObject({ ok: true, status: 200 });
    });

    it('records the same request code in Activity after a confirmed answer', async () => {
      const ticket = ask();
      const code = approvals.getPending(ticket.approvalId)?.requestCode;
      const held = await grant(ticket.approvalId, 'own-tunnel');
      expect(held.status).toBe(428);
      await confirm(held.body.heldActionId);
      expect(events).toHaveLength(1);
      expect(events[0]?.summary).toContain(`Request ${code}`);
      expect(events[0]?.metadata).toMatchObject({ requestCode: code, confirmedWith: 'password' });
    });

    it('notifies the desk once after the last wrong remote password', async () => {
      const held = await grant(ask().approvalId, 'own-tunnel');
      expect(held.status).toBe(428);
      for (let i = 0; i < 5; i++) {
        await request(app('own-tunnel'))
          .post(`/api/step-up/${held.body.heldActionId}/password`)
          .set('Origin', ORIGIN)
          .send({ password: 'made-up wrong password' });
      }
      expect(remoteFailure).toHaveBeenCalledTimes(1);
      expect((await confirm(held.body.heldActionId)).status).toBe(404);
      expect(remoteFailure).toHaveBeenCalledTimes(1);
    });

    it('counts wrong remote passwords across a cancelled and replaced hold', async () => {
      const ticket = ask();
      const first = await grant(ticket.approvalId, 'own-tunnel');
      for (let attempt = 0; attempt < 4; attempt++) {
        await request(app('own-tunnel'))
          .post(`/api/step-up/${first.body.heldActionId}/password`)
          .set('Origin', ORIGIN)
          .send({ password: 'made-up wrong password' });
      }
      expect(remoteFailure).not.toHaveBeenCalled();
      await request(app('own-tunnel'))
        .delete(`/api/step-up/${first.body.heldActionId}`)
        .set('Origin', ORIGIN);
      const second = await grant(ticket.approvalId, 'own-tunnel');
      expect(second.status).toBe(428);
      expect(second.body.heldActionId).not.toBe(first.body.heldActionId);
      await request(app('own-tunnel'))
        .post(`/api/step-up/${second.body.heldActionId}/password`)
        .set('Origin', ORIGIN)
        .send({ password: 'made-up wrong password' });
      expect(remoteFailure).toHaveBeenCalledTimes(1);
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('pending');
    });

    it('denies remotely without a hold', async () => {
      const ticket = ask();
      const res = await request(app('own-tunnel'))
        .post(`/api/approvals/${ticket.approvalId}/deny`)
        .send({});
      expect(res.status).toBe(200);
      expect(approvals.answerScope(ticket.approvalId)?.state).toBe('denied');
    });

    it('sends the same request code on the pending card and sheet', async () => {
      const ticket = ask();
      const list = await request(app('own-tunnel')).get('/api/approvals/pending');
      const card = list.body.approvals[0];
      expect(card.answerNeedsStepUp).toBe(true);
      expect(card.requestCode).toMatch(
        /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}(?:-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}){2}$/
      );
      const held = await grant(ticket.approvalId, 'own-tunnel');
      const sheet = await request(app('own-tunnel')).get(`/api/step-up/${held.body.heldActionId}`);
      expect(sheet.body.requestCode).toBe(card.requestCode);
      expect(sheet.body.reason).toBe(card.summary);
      expect(approvals.getPending(ticket.approvalId)).toMatchObject({
        requestCode: card.requestCode,
      });
    });

    it('names who asked on the sheet, and leaves the code check to the sheet itself', async () => {
      const ticket = ask();
      const held = await grant(ticket.approvalId, 'own-tunnel');
      const sheet = await request(app('own-tunnel')).get(`/api/step-up/${held.body.heldActionId}`);
      expect(sheet.body.notes).toEqual(['Asked by Kestrel.']);
      expect(JSON.stringify(sheet.body.notes)).not.toMatch(/same code/i);
    });
  });
}

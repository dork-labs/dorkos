/** Runtime tool approvals use the same remote confirmation as capability requests. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
} from '../../services/session/session-state-projector.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { createSessionAnswerRoutes } from '../session-answers.js';
import { requestCodeForHash } from '../../services/core/auth/step-up/request-code.js';
import { pendingToolApprovalHash } from '../tool-approval-step-up.js';
import { createStepUpRoutes } from '../step-up.js';
import { readOwnerAccount } from '../../services/core/auth/index.js';
import { setTestOwner } from './test-owner.js';
import {
  currentStepUpExtensionRisks,
  setStepUpExtensionRiskInputs,
} from '../../services/extensions/step-up/step-up-extension-risk.js';

/** Register beside the approvals router's existing configuration fixture. */
export function registerSessionApprovalStepUpCases(): void {
  describe('runtime approval confirmation', () => {
    const target = swappableServer();
    const sessionId = '00000000-0000-4000-8000-0000000000ac';
    const origin = 'http://localhost:4242';
    const password = 'made-up confirmation password';
    let runtime: FakeAgentRuntime;
    const projector = () => getOrCreateProjector(sessionId, '/made-up/kestrel');
    function pending(id = 'tool-one', input = '{"command":"pwd"}') {
      const event = {
        type: 'approval_required',
        id,
        toolName: 'Bash',
        input,
        startedAt: Date.now(),
        remainingMs: 600000,
        timeoutMs: 600000,
        hasSuggestions: true,
        title: 'Run this command?',
      } satisfies Omit<Extract<SessionEvent, { type: 'approval_required' }>, 'seq'>;
      projector().ingest(event);
    }
    function app(remote: boolean | 'managed' = true) {
      return target.mount(
        honoGroupListener(
          [
            {
              path: '/api/sessions',
              routes: createSessionAnswerRoutes({ resolveRuntime: async () => runtime }),
            },
            {
              path: '/api/step-up',
              routes: createStepUpRoutes({
                ownerId: () => readOwnerAccount()?.id ?? null,
                checkPassword: async (value) => (value === password ? 'ok' : 'wrong'),
                setOwnerPassword: async () => undefined,
                minPasswordLength: async () => 8,
                trustedOrigins: () => [origin],
                extensionRisks: currentStepUpExtensionRisks,
              }),
            },
          ],
          {
            before: async (c, next) => {
              if (remote)
                markIngress(c.env.incoming, remote === 'managed' ? 'managed' : 'own-tunnel');
              c.set('user', {
                userId: 'owner',
                credential: 'cookie',
                sessionId: 'phone',
                route: remote ? 'tunnel' : 'local',
              });
              await next();
            },
          }
        )
      );
    }
    beforeEach(() => {
      runtime = new FakeAgentRuntime();
      runtime.approveTool.mockReturnValue(true);
      resetHeldStepUpsForTests();
      setTestOwner('owner');
    });
    afterEach(() => {
      setTestOwner(null);
      disposeProjector(sessionId);
      resetHeldStepUpsForTests();
      vi.restoreAllMocks();
    });
    const approve = (remote: boolean | 'managed' = true, extra = {}) =>
      request(app(remote))
        .post(`/api/sessions/${sessionId}/approve`)
        .set('Origin', origin)
        .send({ toolCallId: 'tool-one', ...extra });
    const confirm = (id: string) =>
      request(app()).post(`/api/step-up/${id}/password`).set('Origin', origin).send({ password });

    it.each([true, 'managed'] as const)(
      'holds a remote Always allow (own tunnel, then managed) before the runtime hears it',
      async (via) => {
        pending();
        const held = await approve(via, { alwaysAllow: true });
        expect(held.status).toBe(428);
        expect(runtime.approveTool).not.toHaveBeenCalled();
        expect((await confirm(held.body.heldActionId)).body).toMatchObject({
          ok: true,
          status: 200,
        });
        expect(runtime.approveTool).toHaveBeenCalledExactlyOnceWith(
          sessionId,
          'tool-one',
          true,
          expect.any(Object)
        );
      }
    );
    it('binds Always allow to its full pending input', async () => {
      pending();
      const held = await approve(true, { alwaysAllow: true });
      expect(held.status).toBe(428);
      pending('tool-one', '{"command":"whoami"}');
      expect((await confirm(held.body.heldActionId)).body.code).toBe('different-request');
      expect(runtime.approveTool).not.toHaveBeenCalled();
    });
    it('holds remote Always allow and a batch before either runs', async () => {
      pending();
      pending('tool-two');
      expect((await approve(true, { alwaysAllow: true })).status).toBe(428);
      const batch = await request(app())
        .post(`/api/sessions/${sessionId}/batch-approve`)
        .set('Origin', origin)
        .send({ toolCallIds: ['tool-one', 'tool-two'] });
      expect(batch.status).toBe(403);
      expect(batch.body.code).toBe('APPROVALS_REQUIRE_SEPARATE_CONFIRMATION');
      const single = await request(app())
        .post(`/api/sessions/${sessionId}/batch-approve`)
        .set('Origin', origin)
        .send({ toolCallIds: ['tool-one'] });
      expect(single.status).toBe(200);
      expect(runtime.approveTool).toHaveBeenCalledTimes(1);
    });

    it('shows the canonical card code when an old session link answers after rekey', async () => {
      pending();
      const canonicalId = '00000000-0000-4000-8000-0000000000ad';
      const firstCode = projector()
        .replayFrom(0)
        .find((event) => event.type === 'approval_required')?.requestCode;
      rekeyProjector(sessionId, canonicalId);
      const card = getOrCreateProjector(
        canonicalId,
        '/made-up/kestrel'
      ).getPendingInteractions()[0];
      expect(card.type === 'approval' && card.requestCode).toBe(firstCode);
      const hash = pendingToolApprovalHash(sessionId, ['tool-one']);
      expect(hash).toBeDefined();
      expect(card.type === 'approval' && card.requestCode).toBe(requestCodeForHash(hash!));
      const held = await approve(true, { alwaysAllow: true });
      const sheet = await request(app()).get(`/api/step-up/${held.body.heldActionId}`);
      expect(sheet.body.requestCode).toBe(card.type === 'approval' && card.requestCode);
      disposeProjector(canonicalId);
    });
    it('names the selected Always allow breadth in the bound confirmation', async () => {
      pending();
      const held = await approve(true, { alwaysAllow: true, alwaysAllowBreadth: 'server' });
      expect(held.status).toBe(428);
      const sheet = await request(app()).get(`/api/step-up/${held.body.heldActionId}`);
      expect(sheet.body.notes).toContain(
        'Always allow every tool from this server, including future tools.'
      );
      await confirm(held.body.heldActionId);
      expect(runtime.approveTool).toHaveBeenCalledWith(
        sessionId,
        'tool-one',
        true,
        expect.objectContaining({ alwaysAllow: true, alwaysAllowBreadth: 'server' })
      );
    });

    it('allows a one-time remote tool call without creating a hold', async () => {
      pending();
      const response = await approve();
      expect(response.status).toBe(200);
      expect(response.body.heldActionId).toBeUndefined();
      expect(runtime.approveTool).toHaveBeenCalledExactlyOnceWith(
        sessionId,
        'tool-one',
        true,
        expect.objectContaining({ alwaysAllow: undefined })
      );
    });

    it('holds desk Always allow before saving the standing rule', async () => {
      pending();
      const response = await approve(false, { alwaysAllow: true });
      expect(response.status).toBe(428);
      expect(runtime.approveTool).not.toHaveBeenCalled();
      const confirmed = await request(app(false))
        .post(`/api/step-up/${response.body.heldActionId}/password`)
        .set('Origin', origin)
        .send({ password });
      expect(confirmed.body).toMatchObject({ ok: true, status: 200 });
      expect(runtime.approveTool).toHaveBeenCalledWith(
        sessionId,
        'tool-one',
        true,
        expect.objectContaining({ alwaysAllow: true })
      );
    });

    it('saves desk Always allow at once while no owner exists, with no password to ask for', async () => {
      setTestOwner(null);
      pending();
      const response = await approve(false, { alwaysAllow: true });
      expect(response.status).toBe(200);
      expect(response.body.heldActionId).toBeUndefined();
      expect(runtime.approveTool).toHaveBeenCalledExactlyOnceWith(
        sessionId,
        'tool-one',
        true,
        expect.objectContaining({ alwaysAllow: true })
      );
    });

    it('keeps desk Always allow held while an agent-editable mini app is loaded, refusing a scripted confirm', async () => {
      // The page could script anything it holds (the cookie, the person proof), so
      // nothing from the page stands in for the person while such code is loaded.
      setStepUpExtensionRiskInputs(() => ({
        records: [
          {
            id: 'risky',
            status: 'compiled',
            path: '/made-up/risky',
            originProblem: 'changed',
            manifest: { name: 'Risky' },
          } as never,
        ],
        approvals: {},
        agents: [],
      }));
      try {
        pending();
        const held = await approve(false, { alwaysAllow: true });
        expect(held.status).toBe(428);
        const scripted = await confirm(held.body.heldActionId);
        expect(scripted.status).toBe(409);
        expect(scripted.body.code).toBe('extension-risk');
        expect(runtime.approveTool).not.toHaveBeenCalled();
      } finally {
        setStepUpExtensionRiskInputs(() => ({ records: [], approvals: {}, agents: [] }));
      }
    });

    it('leaves desk tool approvals and remote denials immediate', async () => {
      pending();
      expect((await approve(false)).status).toBe(200);
      expect(
        (
          await request(app())
            .post(`/api/sessions/${sessionId}/deny`)
            .send({ toolCallId: 'tool-one' })
        ).status
      ).toBe(200);
      expect(runtime.approveTool).toHaveBeenCalledTimes(2);
    });
  });
}

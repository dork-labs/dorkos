/**
 * Letting a mini app read a connected account waits for the owner to confirm
 * it's them (DOR-4355). Not now stays immediate. The page's one-time token is a
 * fake here: its own checks are pinned in `mini-app-access-page.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../env.js';
import type { MiniAppAccess } from '../../services/connectors/extensions/mini-app-access.js';
import type { MiniAppDecisionTokens } from '../../services/connectors/extensions/mini-app-decision-tokens.js';
import { createMiniAppAccessPageRoutes } from '../mini-app-access-page.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const OWNER = { kind: 'local_install', installationId: 'northwind-install' } as const;
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;
const DECISION = '/api/connectors/mini-app-access/decision';
const APPROVE = { token: 'made-up-token', decision: 'approve', connectionId: 'northwind-linear' };

describe('mini app access confirmation', () => {
  const access = {
    describe: vi.fn(),
    approve: vi.fn(() => ({ approvalId: 'approval-a', granted: ['LINEAR_LIST_PROJECTS'] })),
  };
  const tokens = {
    issue: vi.fn(),
    redeem: vi.fn(() => ({
      extensionId: 'northwind-board',
      service: 'linear',
      filesDigest: 'sha256:made-up-files',
    })),
  };
  const owner = frontDoorStepUpHarness(
    () => [
      {
        path: '/api/connectors',
        routes: createMiniAppAccessPageRoutes({
          access: () => access as unknown as MiniAppAccess,
          tokens: tokens as unknown as MiniAppDecisionTokens,
          resolveOwner: () => OWNER,
          loginEnabled: () => true,
          trustedOrigins: () => [ORIGIN],
        }),
      },
    ],
    { headers: () => ({ 'sec-fetch-site': 'same-origin' }) }
  );
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('holds a yes until the owner confirms', async () => {
    const held = await owner.call('post', DECISION, 'own-tunnel').send(APPROVE);
    expect(held.status).toBe(428);
    expect(access.approve).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(access.approve).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
      result: { status: 'approved', granted: ['LINEAR_LIST_PROJECTS'] },
    });
    expect(access.approve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        extensionId: 'northwind-board',
        service: 'linear',
        connectionId: 'northwind-linear',
        filesDigest: 'sha256:made-up-files',
      })
    );
  });

  it('keeps a yes from Wi-Fi refused', async () => {
    const res = await owner.call('post', DECISION, 'wifi').send(APPROVE);
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(access.approve).not.toHaveBeenCalled();
  });

  it('answers Not now at once', async () => {
    const res = await owner
      .call('post', DECISION, 'own-tunnel')
      .send({ token: 'made-up-token', decision: 'deny' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'denied' });
    expect(res.body.heldActionId).toBeUndefined();
    expect(access.approve).not.toHaveBeenCalled();
  });
});

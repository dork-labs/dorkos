/**
 * Allowing a document route gives an agent a standing event route, so it waits
 * for the owner to confirm it's them (DOR-4355). Reviewing and turning one off
 * stay immediate. The full route lifecycle over a real document is in
 * canvas-doc-route-controls.test.ts; this pins the hold itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasDocRouteControlRoutes } from '../canvas-doc-route-controls.js';
import type { DocChannelHttp } from '../canvas-doc-events.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const ROUTE = { id: 'northwind-orders', on: 'order.*', destination: { kind: 'log' } };

describe('allowing a document route waits for the owner', () => {
  const controls = {
    approve: vi.fn(async () => ({ route: ROUTE, approvalId: 'approval-northwind' })),
    revoke: vi.fn(async () => ({ route: ROUTE, revokedGrantIds: [], cancelledApprovalIds: [] })),
  };
  const actor = vi.fn(() => ({ surface: 'http' }));
  const channel = { routeControls: controls, actor } as unknown as DocChannelHttp;
  const owner = frontDoorStepUpHarness(() => [
    { path: '/api/canvas/docs', routes: createCanvasDocRouteControlRoutes(() => channel) },
  ]);
  const body = { expiresAt: '2026-12-01T00:00:00.000Z', reviewHash: 'sha256:northwind' };
  beforeEach(() => {
    resetHeldStepUpsForTests();
    controls.approve.mockClear();
    controls.revoke.mockClear();
  });

  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds allowing a route from %s until the owner confirms it',
    async (via) => {
      const held = await owner
        .call('post', '/api/canvas/docs/northwind-doc/routes/northwind-orders/approve', via)
        .send(body);
      expect(held.status).toBe(428);
      expect(controls.approve).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
        'not-your-action'
      );
      expect(controls.approve).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
        ok: true,
        status: 200,
        result: { route: { id: 'northwind-orders' } },
      });
      expect(controls.approve).toHaveBeenCalledOnce();
      expect(controls.approve).toHaveBeenCalledWith(
        'northwind-doc',
        'northwind-orders',
        body,
        expect.anything(),
        expect.objectContaining({ posture: expect.any(String) })
      );
    }
  );

  it('keeps allowing a route from Wi-Fi refused', async () => {
    const res = await owner
      .call('post', '/api/canvas/docs/northwind-doc/routes/northwind-orders/approve', 'wifi')
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(controls.approve).not.toHaveBeenCalled();
  });

  it('turns a route off at once', async () => {
    const res = await owner
      .call('post', '/api/canvas/docs/northwind-doc/routes/northwind-orders/revoke', 'own-tunnel')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(controls.revoke).toHaveBeenCalledOnce();
  });
});

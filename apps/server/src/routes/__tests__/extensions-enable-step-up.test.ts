/**
 * Turning an extension on writes the same lasting setting `PATCH /api/config` holds
 * (`extensions.enabled`), so it waits for the owner to confirm it's them too (DOR-4355).
 * Turning one off stays immediate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtensionsRoutes } from '../extensions.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const RECORD = {
  id: 'northwind-tool',
  manifest: { id: 'northwind-tool', name: 'Northwind Tool', version: '1.0.0' },
  status: 'compiled',
  scope: 'global',
  origin: 'user',
  path: '/made-up/extensions/northwind-tool',
  bundleReady: true,
  hasServerEntry: false,
  hasDataProxy: false,
};

describe('extension enable confirmation', () => {
  const manager = {
    get: vi.fn(() => RECORD),
    enable: vi.fn(async () => ({ extension: RECORD, reloadRequired: false })),
    disable: vi.fn(async () => ({ extension: RECORD, reloadRequired: false })),
    listPublic: vi.fn(() => []),
    listShadowedPublic: vi.fn(() => []),
  };
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/extensions',
      routes: createExtensionsRoutes({
        manager: manager as unknown as Parameters<typeof createExtensionsRoutes>[0]['manager'],
        dorkHome: '/made-up/dork-home',
        getCwd: () => null,
      }),
    },
  ]);
  beforeEach(() => {
    manager.enable.mockClear();
    manager.disable.mockClear();
  });

  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds turning one on from %s',
    async (via) => {
      const held = await owner.call('post', '/api/extensions/northwind-tool/enable', via).send({});
      expect(held.status).toBe(428);
      expect(manager.enable).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
        'not-your-action'
      );
      expect(manager.enable).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
        ok: true,
        status: 200,
      });
      expect(manager.enable).toHaveBeenCalledExactlyOnceWith('northwind-tool');
    }
  );

  it('keeps turning one on from Wi-Fi refused', async () => {
    const res = await owner.call('post', '/api/extensions/northwind-tool/enable', 'wifi').send({});
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(manager.enable).not.toHaveBeenCalled();
  });

  it('turns one off at once', async () => {
    const res = await owner
      .call('post', '/api/extensions/northwind-tool/disable', 'own-tunnel')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(manager.disable).toHaveBeenCalledOnce();
  });
});

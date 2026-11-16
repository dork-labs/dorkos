import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLanAccessStatus } from '@dorkos/test-utils';
import { createLanAccessRoutes } from '../lan-access.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('Wi-Fi access confirmation', () => {
  const status = createLanAccessStatus({ supported: true });
  const writeSetting = vi.fn();
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/lan-access',
      routes: createLanAccessRoutes({
        lanAccess: { status: () => status, reconcile: async () => status },
        writeSetting,
        canExpose: () => true,
      }),
    },
  ]);
  beforeEach(() => writeSetting.mockClear());

  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds opening from %s until the owner confirms',
    async (via) => {
      const held = await owner.call('post', '/api/lan-access', via).send({ enabled: true });
      expect(held.status).toBe(428);
      expect(writeSetting).not.toHaveBeenCalled();
      const other = await owner.confirm(held.body.heldActionId, via, true);
      expect(other.body.code).toBe('not-your-action');
      expect(writeSetting).not.toHaveBeenCalled();
      const confirmed = await owner.confirm(held.body.heldActionId, via);
      expect(confirmed.body).toMatchObject({ ok: true, status: 200 });
      expect(writeSetting).toHaveBeenCalledWith(true);
    }
  );

  it('keeps the Wi-Fi refusal before holding or writing', async () => {
    const res = await owner.call('post', '/api/lan-access', 'wifi').send({ enabled: true });
    expect(res.status).toBe(403);
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it('turns access off without a hold', async () => {
    const res = await owner.call('post', '/api/lan-access', 'own-tunnel').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(writeSetting).toHaveBeenCalledWith(false);
  });
});

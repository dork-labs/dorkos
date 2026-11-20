import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoteAccessReport } from '@dorkos/test-utils';
import { createRemoteAccessRoutes } from '../remote-access.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('Remote Access confirmation', () => {
  const coordinator = {
    report: async () => createRemoteAccessReport(),
    startEnrolment: vi.fn(async () => ({ ok: true as const })),
    selectMode: vi.fn(async () => ({ ok: true as const })),
    close: vi.fn(),
    withdraw: vi.fn(async () => 'done' as const),
  };
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/remote-access',
      routes: createRemoteAccessRoutes({
        coordinator,
        canExpose: () => true,
        stopOwnTunnel: async () => undefined,
      }),
    },
  ]);
  beforeEach(() => vi.clearAllMocks());

  describe.each([
    ['/enrolment', {}, coordinator.startEnrolment],
    ['/mode', { mode: 'managed' }, coordinator.selectMode],
    ['/mode', { mode: 'byo' }, coordinator.selectMode],
  ] as const)('%s %j', (path, body, effect) => {
    it.each(['direct', 'own-tunnel', 'managed'] as const)(
      'holds the change from %s',
      async (via) => {
        const held = await owner.call('post', `/api/remote-access${path}`, via).send(body);
        expect(held.status).toBe(428);
        expect(effect).not.toHaveBeenCalled();
        expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
          'not-your-action'
        );
        expect(effect).not.toHaveBeenCalled();
        expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
          ok: true,
          status: 200,
        });
        expect(effect).toHaveBeenCalledOnce();
      }
    );
    it('keeps the Wi-Fi refusal', async () => {
      expect(
        (await owner.call('post', `/api/remote-access${path}`, 'wifi').send(body)).status
      ).toBe(403);
      expect(effect).not.toHaveBeenCalled();
    });
  });

  it.each(['/close', '/withdraw'])('does not hold narrowing %s', async (path) => {
    expect(
      (await owner.call('post', `/api/remote-access${path}`, 'own-tunnel').send({})).status
    ).toBe(200);
  });
  it('does not hold turning access off', async () => {
    expect(
      (await owner.call('post', '/api/remote-access/mode', 'own-tunnel').send({ mode: 'off' }))
        .status
    ).toBe(200);
    expect(coordinator.selectMode).toHaveBeenCalledWith('off');
  });
});

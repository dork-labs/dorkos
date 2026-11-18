import { describe, expect, it } from 'vitest';
import { createDevicesRoutes } from '../devices.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';
import { deviceIdOf } from '../../services/core/auth/sessions/signed-in-devices.js';

describe('signed-in device confirmation', () => {
  const owner = frontDoorStepUpHarness(() => [
    { path: '/api/devices', routes: createDevicesRoutes() },
  ]);

  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds signing another device out from %s',
    async (via) => {
      const made = await owner.signIn('wifi');
      const cookie = (made.headers['set-cookie'] as unknown as string[])
        .map((value) => value.split(';')[0])
        .join('; ');
      const signedIn = await owner.auth()!.api.getSession({ headers: new Headers({ cookie }) });
      const before = await owner.call('get', '/api/devices/sessions', via);
      const other = before.body.sessions.find(
        (device: { id: string }) => device.id === deviceIdOf(signedIn!.session.id)
      );
      expect(other).toBeDefined();
      const held = await owner.call('delete', `/api/devices/sessions/${other.id}`, via);
      expect(held.status).toBe(428);
      expect((await owner.call('get', '/api/devices/sessions', via)).body.sessions).toContainEqual(
        other
      );
      expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
        'not-your-action'
      );
      expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
        ok: true,
        status: 204,
      });
      expect(
        (await owner.call('get', '/api/devices/sessions', via)).body.sessions
      ).not.toContainEqual(expect.objectContaining({ id: other.id }));
    }
  );

  it('keeps signing other devices out from Wi-Fi refused', async () => {
    const list = await owner.call('get', '/api/devices/sessions', 'wifi');
    const other = list.body.sessions.find((device: { current: boolean }) => !device.current);
    expect((await owner.call('delete', `/api/devices/sessions/${other.id}`, 'wifi')).status).toBe(
      403
    );
  });

  it('holds signing out others, and binds it to the asking browser', async () => {
    const held = await owner.call('post', '/api/devices/sign-out-all', 'own-tunnel').send({});
    expect(held.status).toBe(428);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
  });

  it('signs this device out without a hold', async () => {
    const list = await owner.call('get', '/api/devices/sessions', 'own-tunnel');
    const own = list.body.sessions.find((device: { current: boolean }) => device.current);
    expect(
      (await owner.call('delete', `/api/devices/sessions/${own.id}`, 'own-tunnel')).status
    ).toBe(204);
  });

  it('confirms signing out others once and keeps the asking browser', async () => {
    const held = await owner.call('post', '/api/devices/sign-out-all').send({});
    expect(held.status).toBe(428);
    const confirmed = await owner.confirm(held.body.heldActionId);
    expect(confirmed.body).toMatchObject({ ok: true, status: 200 });
    expect(confirmed.body.result.signedOut).toBeGreaterThan(0);
    const remaining = await owner.call('get', '/api/devices/sessions');
    expect(remaining.status).toBe(200);
    expect(remaining.body.sessions).toHaveLength(1);
    expect(remaining.body.sessions[0].current).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('device confirmation through the auth endpoints', () => {
  const owner = frontDoorStepUpHarness(() => []);
  describe.each(['revoke-session', 'revoke-other-sessions', 'revoke-sessions'])('%s', (action) => {
    it.each(['direct', 'own-tunnel', 'managed'] as const)(
      'holds other-device sign-out from %s',
      async (via) => {
        await owner.renew(via);
        await owner.renew(via, true);
        const made = await owner.signIn('direct');
        const cookie = (made.headers['set-cookie'] as unknown as string[])
          .map((value) => value.split(';')[0])
          .join('; ');
        const target = await owner.auth()!.api.getSession({
          headers: new Headers({ cookie }),
          query: { disableCookieCache: true, disableRefresh: true },
        });
        const input = action === 'revoke-session' ? { token: target!.session.token } : {};
        const held = await owner.call('post', `/api/auth/${action}`, via).send(input);
        expect(held.status).toBe(428);
        expect(
          await owner.auth()!.api.getSession({
            headers: new Headers({ cookie }),
            query: { disableCookieCache: true, disableRefresh: true },
          })
        ).not.toBeNull();
        expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
          'not-your-action'
        );
        expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
          ok: true,
          status: 200,
        });
        expect(
          await owner.auth()!.api.getSession({
            headers: new Headers({ cookie }),
            query: { disableCookieCache: true, disableRefresh: true },
          })
        ).toBeNull();
      }
    );
    it('keeps other-device sign-out from Wi-Fi refused', async () => {
      await owner.renew('wifi');
      const res = await owner
        .call('post', `/api/auth/${action}`, 'wifi')
        .send({ token: 'made-up-other-session' });
      expect(res.status).toBe(403);
    });
  });
  it.each(['revoke-session', 'revoke-other-sessions', 'revoke-sessions'])(
    'keeps unauthenticated %s at 401 without a hold',
    async (action) => {
      const refused = await owner
        .call('post', `/api/auth/${action}`, 'own-tunnel')
        .set('Cookie', '')
        .send({ token: 'made-up-other-session' });
      expect(refused.status).toBe(401);
      expect(refused.body.heldActionId).toBeUndefined();
      expect(refused.body.error).toBe('Sign in to change access.');
    }
  );
  it('keeps ending your own session free', async () => {
    await owner.renew('own-tunnel');
    const current = await owner.auth()!.api.getSession({
      headers: new Headers({ cookie: owner.currentCookie('own-tunnel') }),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    expect(
      (
        await owner
          .call('post', '/api/auth/revoke-session', 'own-tunnel')
          .send({ token: current!.session.token })
      ).status
    ).toBe(200);
  });
});

/** The signed-in device and owner-factor calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PASSKEY_CHECK_CODE } from '@dorkos/shared/signed-in-devices';
import { createDeviceMethods } from '../device-methods';
import { answer, firstRequest } from './request-stub';

/** The first request, with `fetch`'s own GET default named and its JSON type read. */
function sent(fetchMock: ReturnType<typeof answer>) {
  const request = firstRequest(fetchMock);
  const init = fetchMock.mock.calls[0]![1];
  return {
    ...request,
    method: request.method ?? 'GET',
    type: new Headers(init?.headers).get('Content-Type'),
  };
}

/** Answer every request with `status` and `body`. */
function refuse(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(body), { status })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('createDeviceMethods', () => {
  const methods = createDeviceMethods('/api');
  const json = 'application/json';

  it('sends each moved call at the same path, method and body', async () => {
    const calls: Array<[() => Promise<unknown>, ReturnType<typeof sent>]> = [
      [
        () => methods.listSignedInDevices(),
        { url: '/api/devices/sessions', method: 'GET', body: undefined, type: json },
      ],
      [
        () => methods.signOutDevice('s 1/x'),
        { url: '/api/devices/sessions/s%201%2Fx', method: 'DELETE', body: undefined, type: json },
      ],
      [
        () => methods.setDeviceRunsAgents('s/1', true),
        {
          url: '/api/devices/sessions/s%2F1/runs-agents',
          method: 'PUT',
          body: '{"on":true}',
          type: json,
        },
      ],
      [
        () => methods.setDeviceRunsAgents('s/1', false, { id: 'cred' }),
        {
          url: '/api/devices/sessions/s%2F1/runs-agents',
          method: 'PUT',
          body: '{"on":false,"passkey":{"id":"cred"}}',
          type: json,
        },
      ],
      [
        () => methods.listWifiSignInRequests(),
        { url: '/api/devices/sign-in-requests', method: 'GET', body: undefined, type: json },
      ],
      [
        () => methods.approveWifiSignIn('r/1'),
        {
          url: '/api/devices/sign-in-requests/r%2F1/approve',
          method: 'POST',
          body: '{}',
          type: json,
        },
      ],
      [
        () => methods.approveWifiSignIn('r/1', { id: 'cred' }),
        {
          url: '/api/devices/sign-in-requests/r%2F1/approve',
          method: 'POST',
          body: '{"passkey":{"id":"cred"}}',
          type: json,
        },
      ],
      [
        () => methods.declineWifiSignIn('r/1'),
        {
          url: '/api/devices/sign-in-requests/r%2F1/decline',
          method: 'POST',
          body: undefined,
          type: json,
        },
      ],
      [
        () => methods.listOwnerFactors(),
        { url: '/api/owner-factors', method: 'GET', body: undefined, type: json },
      ],
      [
        () => methods.finishAddingPasskey({ id: 'cred', type: 'public-key' }),
        {
          url: '/api/owner-factors/passkeys/finish',
          method: 'POST',
          body: '{"response":{"id":"cred","type":"public-key"}}',
          type: json,
        },
      ],
      [
        () => methods.confirmAuthenticator('f/1', '123456'),
        {
          url: '/api/owner-factors/authenticator/confirm',
          method: 'POST',
          body: '{"id":"f/1","code":"123456"}',
          type: json,
        },
      ],
    ];
    for (const [call, expected] of calls) {
      const fetchMock = answer({ code: 'C0DE', expiresAt: '2026-11-27T00:00:00.000Z' });
      await call();
      expect(sent(fetchMock)).toEqual(expected);
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
    }
  });

  it('answers the approved code, and still reads a passkey check from a 428', async () => {
    answer({ code: 'C0DE', expiresAt: '2026-11-27T00:00:00.000Z' });
    await expect(methods.approveWifiSignIn('r1')).resolves.toEqual({
      kind: 'approved',
      code: 'C0DE',
      expiresAt: '2026-11-27T00:00:00.000Z',
    });
    const options = { challenge: 'abc' };
    refuse(428, { code: PASSKEY_CHECK_CODE, options });
    await expect(methods.approveWifiSignIn('r1')).resolves.toEqual({
      kind: 'passkey-check',
      options,
    });
    refuse(428, { code: PASSKEY_CHECK_CODE, options });
    await expect(methods.setDeviceRunsAgents('s1', true)).resolves.toEqual({
      kind: 'passkey-check',
      options,
    });
  });
});

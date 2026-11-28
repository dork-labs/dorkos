/** The hub and session-relay calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubMethods } from '../hub-methods';
import { answer, firstRequest } from './request-stub';

/** The first request, with `fetch`'s own GET default named. */
function sent(fetchMock: ReturnType<typeof answer>) {
  const request = firstRequest(fetchMock);
  return { ...request, method: request.method ?? 'GET' };
}

afterEach(() => vi.unstubAllGlobals());

describe('createHubMethods', () => {
  const methods = createHubMethods('/api');

  it('sends each hub and relay call at the same path, method and body', async () => {
    const calls: Array<[() => Promise<unknown>, ReturnType<typeof sent>]> = [
      [
        () => methods.listHubComputers(),
        { url: '/api/hub/computers', method: 'GET', body: undefined },
      ],
      [
        () => methods.createHubLinkCode(),
        { url: '/api/hub/computers/link-code', method: 'POST', body: undefined },
      ],
      [
        () => methods.removeHubComputer('c 1/x'),
        { url: '/api/hub/computers/c%201%2Fx', method: 'DELETE', body: undefined },
      ],
      [
        () => methods.getSessionRelayStatus(),
        { url: '/api/session-relay/status', method: 'GET', body: undefined },
      ],
      [
        () => methods.linkSessionRelay({ linkCode: 'ABC@hub.example' }),
        {
          url: '/api/session-relay/link',
          method: 'POST',
          body: '{"linkCode":"ABC@hub.example"}',
        },
      ],
      [
        () => methods.setSessionRelayLevel('full'),
        { url: '/api/session-relay/level', method: 'PATCH', body: '{"level":"full"}' },
      ],
      [
        () => methods.pauseSessionRelay(),
        { url: '/api/session-relay/pause', method: 'POST', body: undefined },
      ],
      [
        () => methods.resumeSessionRelay(),
        { url: '/api/session-relay/resume', method: 'POST', body: undefined },
      ],
      [
        () => methods.endSessionRelayPresence(),
        { url: '/api/session-relay/presence/end', method: 'POST', body: undefined },
      ],
      [
        () => methods.unlinkSessionRelay(),
        { url: '/api/session-relay/link', method: 'DELETE', body: undefined },
      ],
      [
        () => methods.getSessionRelayPresence(),
        { url: '/api/session-relay/presence', method: 'GET', body: undefined },
      ],
      [
        () => methods.listSessionRelayDevices(),
        { url: '/api/session-relay/devices', method: 'GET', body: undefined },
      ],
      [
        () => methods.listSessionRelayPasskeys(),
        { url: '/api/session-relay/passkeys', method: 'GET', body: undefined },
      ],
      [
        () => methods.startSessionRelayPasskey({ label: 'Phone' }),
        { url: '/api/session-relay/passkeys/start', method: 'POST', body: '{"label":"Phone"}' },
      ],
      [
        () => methods.removeSessionRelayPasskey('k/1', 'pw'),
        { url: '/api/session-relay/passkeys/k%2F1', method: 'DELETE', body: '{"password":"pw"}' },
      ],
      [
        () => methods.removeDamagedSessionRelayPasskeys('pw'),
        { url: '/api/session-relay/passkeys', method: 'DELETE', body: '{"password":"pw"}' },
      ],
    ];
    for (const [call, expected] of calls) {
      const fetchMock = answer({});
      await call();
      expect(sent(fetchMock)).toEqual(expected);
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
    }
  });
});

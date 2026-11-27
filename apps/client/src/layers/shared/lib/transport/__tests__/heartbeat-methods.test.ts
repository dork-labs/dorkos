/** The heartbeat calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeartbeatMethods } from '../heartbeat-methods';

/** Answer every request with one JSON body, and record what was sent. */
function answer(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL, method (`fetch` sends GET when none is named) and body of the first request. */
function sent(fetchMock: ReturnType<typeof answer>) {
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url, method: init?.method ?? 'GET', body: init?.body };
}

afterEach(() => vi.unstubAllGlobals());

describe('createHeartbeatMethods', () => {
  const methods = createHeartbeatMethods('/api');

  it('reads an agent’s page at its encoded id', async () => {
    const fetchMock = answer({});
    await methods.getAgentHeartbeat('agent 1');
    expect(sent(fetchMock)).toEqual({
      url: '/api/agents/agent%201/heartbeat',
      method: 'GET',
      body: undefined,
    });
  });

  it('puts the credits choice and reads the wakers that are off', async () => {
    let fetchMock = answer({ useCredits: true });
    await methods.chooseTriageCredits(true);
    expect(sent(fetchMock)).toEqual({
      url: '/api/heartbeats/triage-credits',
      method: 'PUT',
      body: '{"useCredits":true}',
    });

    fetchMock = answer({ wakers: [] });
    await methods.listWakersOff();
    expect(sent(fetchMock)).toEqual({
      url: '/api/heartbeats/wakers-off',
      method: 'GET',
      body: undefined,
    });
  });
});

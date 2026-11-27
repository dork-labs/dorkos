/** The permission reads send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPermissionMethods } from '../permission-methods';

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

describe('createPermissionMethods', () => {
  const methods = createPermissionMethods('/api');

  it('reads one agent’s permissions and level at its encoded id', async () => {
    let fetchMock = answer({});
    await methods.getAgentPermissions('agent 1');
    expect(sent(fetchMock)).toEqual({
      url: '/api/agents/agent%201/permissions',
      method: 'GET',
      body: undefined,
    });

    fetchMock = answer({});
    await methods.getAgentLevel('agent/1');
    expect(sent(fetchMock)).toEqual({
      url: '/api/agents/agent%2F1/level',
      method: 'GET',
      body: undefined,
    });
  });
});

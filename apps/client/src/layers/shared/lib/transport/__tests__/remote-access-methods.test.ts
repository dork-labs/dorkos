/** The remote access calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteAccessMethods } from '../remote-access-methods';

/** Answer every request with one JSON body, and record what was sent. */
function answer(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL, method, body and content type of the first request. */
function sent(fetchMock: ReturnType<typeof answer>) {
  const [url, init] = fetchMock.mock.calls[0]!;
  return {
    url,
    method: init?.method ?? 'GET',
    body: init?.body,
    contentType: new Headers(init?.headers).get('Content-Type'),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('createRemoteAccessMethods', () => {
  const methods = createRemoteAccessMethods('/api');

  it('posts the chosen mode as JSON', async () => {
    const fetchMock = answer({});
    await methods.setRemoteAccessMode('managed');
    expect(sent(fetchMock)).toEqual({
      url: '/api/remote-access/mode',
      method: 'POST',
      body: '{"mode":"managed"}',
      contentType: 'application/json',
    });
  });

  it('posts the Wi-Fi switch as JSON', async () => {
    const fetchMock = answer({ enabled: false });
    await methods.setLanAccess(false);
    expect(sent(fetchMock)).toEqual({
      url: '/api/lan-access',
      method: 'POST',
      body: '{"enabled":false}',
      contentType: 'application/json',
    });
  });
});

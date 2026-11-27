/** The web push calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPushMethods } from '../push-methods';

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

describe('createPushMethods', () => {
  const methods = createPushMethods('/api');

  it('reads the key and the list with bodyless GETs', async () => {
    let fetchMock = answer({ publicKey: 'made-up-key' });
    await expect(methods.getPushVapidPublicKey()).resolves.toEqual({ publicKey: 'made-up-key' });
    expect(sent(fetchMock)).toEqual({
      url: '/api/push/vapid-public-key',
      method: 'GET',
      body: undefined,
    });

    fetchMock = answer({ subscriptions: [] });
    await methods.listPushSubscriptions();
    expect(sent(fetchMock)).toEqual({
      url: '/api/push/subscriptions',
      method: 'GET',
      body: undefined,
    });
  });

  it('posts a subscription as it was given and deletes one at its encoded id', async () => {
    const subscription = {
      endpoint: 'https://push.example.test/made-up',
      keys: { p256dh: 'made-up-p256dh', auth: 'made-up-auth' },
    };
    let fetchMock = answer({ id: 'sub-1' });
    await methods.registerPushSubscription(subscription);
    expect(sent(fetchMock)).toEqual({
      url: '/api/push/subscriptions',
      method: 'POST',
      body: JSON.stringify(subscription),
    });

    fetchMock = answer({ deleted: true });
    await methods.deletePushSubscription('sub 1');
    expect(sent(fetchMock)).toEqual({
      url: '/api/push/subscriptions/sub%201',
      method: 'DELETE',
      body: undefined,
    });
  });
});

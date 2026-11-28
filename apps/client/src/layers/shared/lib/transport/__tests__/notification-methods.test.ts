/** The Inbox calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationMethods } from '../notification-methods';

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

describe('createNotificationMethods', () => {
  const methods = createNotificationMethods('/api');

  it('sends the filters in order, kinds comma-joined, and nothing for an absent lens', async () => {
    let fetchMock = answer({ notifications: [], nextCursor: null });
    await methods.listNotifications({
      limit: 10,
      agentId: 'a b',
      kind: ['run.completed', 'agent.note'],
      unread: true,
    });
    expect(sent(fetchMock).url).toBe(
      '/api/notifications?limit=10&agentId=a+b&kind=run.completed%2Cagent.note&unread=true'
    );

    fetchMock = answer({ notifications: [], nextCursor: null });
    await methods.listNotifications({ kind: [], unread: false });
    expect(sent(fetchMock)).toEqual({ url: '/api/notifications', method: 'GET', body: undefined });
  });

  it('marks one read and all read', async () => {
    let fetchMock = answer({ updated: 1 });
    await methods.markNotificationRead('n/1');
    expect(sent(fetchMock)).toEqual({
      url: '/api/notifications/n%2F1',
      method: 'PATCH',
      body: '{"read":true}',
    });

    fetchMock = answer({ updated: 3 });
    await methods.markAllNotificationsRead();
    expect(sent(fetchMock)).toEqual({
      url: '/api/notifications',
      method: 'PATCH',
      body: '{"read":true}',
    });
  });
});

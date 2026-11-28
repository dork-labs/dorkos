/** The Shape calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShapeMethods } from '../shape-methods';

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

describe('createShapeMethods', () => {
  const methods = createShapeMethods('/api');

  // Purpose (DOR-4982): the list comes in pages; every page is read, A to Z as sent.
  it('lists every page of installed shapes out of their envelope, in order', async () => {
    const pages = [
      { shapes: [{ name: 'alpha' }], nextCursor: 'c1' },
      { shapes: [{ name: 'solo' }], nextCursor: null },
    ];
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(pages.shift()), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(methods.listShapes()).resolves.toEqual([{ name: 'alpha' }, { name: 'solo' }]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/shapes?limit=200',
      '/api/shapes?limit=200&cursor=c1',
    ]);
  });

  it('applies and forks a shape at its encoded name', async () => {
    let fetchMock = answer({});
    await methods.applyShape('my shape');
    expect(sent(fetchMock)).toEqual({
      url: '/api/shapes/my%20shape/apply',
      method: 'POST',
      body: undefined,
    });

    fetchMock = answer({});
    await methods.forkShape('solo');
    expect(sent(fetchMock)).toEqual({ url: '/api/shapes/solo/fork', method: 'POST', body: '{}' });

    fetchMock = answer({});
    await methods.forkShape('solo', { as: 'mine' });
    expect(sent(fetchMock).body).toBe('{"as":"mine"}');
  });
});

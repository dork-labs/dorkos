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

  it('lists the installed shapes out of their envelope', async () => {
    const fetchMock = answer({ shapes: [{ name: 'solo' }] });
    await expect(methods.listShapes()).resolves.toEqual([{ name: 'solo' }]);
    expect(sent(fetchMock)).toEqual({ url: '/api/shapes', method: 'GET', body: undefined });
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

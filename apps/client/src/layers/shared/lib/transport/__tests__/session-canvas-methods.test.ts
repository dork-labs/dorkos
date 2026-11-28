/** The session canvas calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionCanvasMethods } from '../session-canvas-methods';
import { answer, firstRequest } from './request-stub';

/** The first request, with `fetch`'s own GET default named. */
function sent(fetchMock: ReturnType<typeof answer>) {
  const request = firstRequest(fetchMock);
  return { ...request, method: request.method ?? 'GET' };
}

afterEach(() => vi.unstubAllGlobals());

describe('createSessionCanvasMethods', () => {
  const methods = createSessionCanvasMethods('/api');

  it('sends each moved call at the same path, method and body', async () => {
    const calls: Array<[() => Promise<unknown>, ReturnType<typeof sent>]> = [
      [
        () => methods.listSessionCanvas('s 1/x'),
        { url: '/api/sessions/s%201%2Fx/canvas', method: 'GET', body: undefined },
      ],
      [
        () => methods.getSessionCanvasDocument('s/1', 'd/1'),
        { url: '/api/sessions/s%2F1/canvas/d%2F1', method: 'GET', body: undefined },
      ],
      [
        () => methods.closeSessionCanvasDocument('s/1', 'd/1'),
        { url: '/api/sessions/s%2F1/canvas/d%2F1', method: 'DELETE', body: undefined },
      ],
      [
        () => methods.setSessionCanvasEditing('s/1', 'd/1', true),
        {
          url: '/api/sessions/s%2F1/canvas/d%2F1/editing',
          method: 'POST',
          body: '{"editing":true}',
        },
      ],
    ];
    for (const [call, expected] of calls) {
      const fetchMock = answer({ documents: [] });
      await call();
      expect(sent(fetchMock)).toEqual(expected);
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
    }
  });

  it('reads the list, and answers null for a document that is not there', async () => {
    answer({ documents: [{ id: 'd1' }] });
    await expect(methods.listSessionCanvas('s1')).resolves.toEqual([{ id: 'd1' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ title: 'Not Found', status: 404 }), { status: 404 })
      )
    );
    await expect(methods.getSessionCanvasDocument('s1', 'gone')).resolves.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ title: 'Forbidden', status: 403 }), { status: 403 })
      )
    );
    await expect(methods.getSessionCanvasDocument('s1', 'd1')).rejects.toMatchObject({
      status: 403,
    });
  });
});

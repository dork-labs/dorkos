/**
 * A `fetch` stub for transport slice tests: answers every request with one JSON
 * body and records what was sent.
 */
import { vi } from 'vitest';

/** Replace global `fetch` with a stub answering `body`, and hand back the stub. */
export function answer(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL, method and body of the stub's first request. */
export function firstRequest(fetchMock: ReturnType<typeof answer>) {
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url, method: init?.method, body: init?.body };
}

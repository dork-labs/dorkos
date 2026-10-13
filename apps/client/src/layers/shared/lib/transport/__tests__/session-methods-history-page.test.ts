// @vitest-environment jsdom
/**
 * A page of older messages (DOR-2889) never rides the whole history's ETag:
 * the tag names the whole transcript, so a page answered 304 would hand back
 * the cached whole history in its place.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSessionMethods } from '../session-methods';

function respond(body: unknown, etag: string | null) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'ETag' ? etag : null) },
    json: () => Promise.resolve(body),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('getMessages', () => {
  it('asks for the page before a message, without the whole history’s ETag', async () => {
    const etags = new Map<string, string>();
    const cache = new Map();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond({ messages: [] }, '"whole"'))
      .mockResolvedValueOnce(respond({ messages: [], earlierMessages: 3 }, '"whole"'));
    vi.stubGlobal('fetch', fetchMock);
    const methods = createSessionMethods('http://x/api', () => 'c', etags, cache);

    await methods.getMessages('s1');
    const page = await methods.getMessages('s1', undefined, 'm9');

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('http://x/api/sessions/s1/messages?before=m9');
    expect((init as RequestInit).headers).not.toHaveProperty('If-None-Match');
    expect(page.earlierMessages).toBe(3);
    // The page never replaces the cached whole history.
    expect(cache.get('s1')).toEqual({ messages: [] });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDocCommentMethods } from '../doc-comment-methods';

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** The URL, method and parsed body of the one request made. */
function sent() {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

const DOC = { cwd: '/work', path: 'notes/plan.md' };

describe('createDocCommentMethods', () => {
  const methods = createDocCommentMethods('/api', () => 'tab-1');

  it('lists a doc’s threads with the doc in the query', async () => {
    await methods.listDocCommentThreads(DOC);
    expect(sent()).toEqual({
      url: '/api/documents/comments?cwd=%2Fwork&path=notes%2Fplan.md',
      method: 'GET',
      body: undefined,
    });
  });

  it('writes each change to its own route', async () => {
    await methods.createDocCommentThread({ ...DOC, anchor: { v: 1 }, body: 'Hi' });
    expect(sent()).toMatchObject({ url: '/api/documents/comments/threads', method: 'POST' });
    // With login off, the client id is how the server knows the app wrote it.
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('X-Client-Id')).toBe('tab-1');

    fetchMock.mockClear();
    await methods.replyDocComment('t/1', { ...DOC, body: 'Yes' });
    expect(sent()).toMatchObject({
      url: '/api/documents/comments/threads/t%2F1/replies',
      method: 'POST',
      body: { ...DOC, body: 'Yes' },
    });

    fetchMock.mockClear();
    await methods.setDocCommentThreadResolved('t1', { ...DOC, resolved: true });
    expect(sent()).toMatchObject({ url: '/api/documents/comments/threads/t1', method: 'PATCH' });

    fetchMock.mockClear();
    await methods.editDocComment('t1', 'c1', { ...DOC, body: 'Edited' });
    expect(sent()).toMatchObject({
      url: '/api/documents/comments/threads/t1/comments/c1',
      method: 'PATCH',
    });

    fetchMock.mockClear();
    await methods.updateDocCommentAnchors({ ...DOC, updates: [] });
    expect(sent()).toMatchObject({ url: '/api/documents/comments/anchors', method: 'PUT' });

    fetchMock.mockClear();
    await methods.listDocCommentMentionable();
    expect(sent()).toMatchObject({ url: '/api/documents/comments/mentionable', method: 'GET' });
  });
});

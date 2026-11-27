/** The to-do calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTodoPromiseMethods } from '../todo-promise-methods';

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

describe('createTodoPromiseMethods', () => {
  const methods = createTodoPromiseMethods('/api');

  it('sends only the filters that are set, an empty string being none', async () => {
    let fetchMock = answer({ todoPromises: [] });
    await methods.listTodoPromises({ agentId: 'a b', state: 'open', to: 'me' });
    expect(sent(fetchMock)).toEqual({
      url: '/api/todo-promises?agentId=a+b&state=open&to=me',
      method: 'GET',
      body: undefined,
    });

    fetchMock = answer({ todoPromises: [] });
    await methods.listTodoPromises({ agentId: '' });
    expect(sent(fetchMock).url).toBe('/api/todo-promises');
  });

  it('adds, changes and confirms a promise at its encoded id', async () => {
    let fetchMock = answer({});
    await methods.createTodoPromise('agent 1', { what: 'Ship it' });
    expect(sent(fetchMock)).toEqual({
      url: '/api/agents/agent%201/todo-promises',
      method: 'POST',
      body: '{"what":"Ship it"}',
    });

    fetchMock = answer({});
    await methods.updateTodoPromise('p/1', { state: 'dropped' });
    expect(sent(fetchMock)).toEqual({
      url: '/api/todo-promises/p%2F1',
      method: 'PATCH',
      body: '{"state":"dropped"}',
    });

    fetchMock = answer({});
    await methods.confirmTodoPromise('p1', 'yes');
    expect(sent(fetchMock)).toEqual({
      url: '/api/todo-promises/p1/confirm',
      method: 'POST',
      body: '{"answer":"yes"}',
    });
  });
});

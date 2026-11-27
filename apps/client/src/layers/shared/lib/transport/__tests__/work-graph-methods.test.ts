/**
 * The work graph's reads over the real HTTP methods and a stubbed `fetch`: the
 * paths their capabilities serve, and answers checked against their schemas.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkGraphMethods } from '../work-graph-methods';

/** Answer every request with this JSON body. */
function serverAnswers(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The path of the request a call made. */
function pathOf(fetchMock: ReturnType<typeof serverAnswers>): string {
  return String(fetchMock.mock.calls[0]?.[0]);
}

const EMPTY_TREE = {
  chatId: 'c1',
  state: { kind: 'chat' },
  ancestors: [],
  descendants: [],
  truncated: false,
  nextCursor: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('the work graph methods', () => {
  it('asks a chat’s tree at its path, with the cursor only when there is one', async () => {
    const methods = createWorkGraphMethods('/api');
    const first = serverAnswers(EMPTY_TREE);
    await expect(methods.getChatTree('c1')).resolves.toEqual(EMPTY_TREE);
    expect(pathOf(first)).toBe('/api/sessions/c1/tree');

    const next = serverAnswers(EMPTY_TREE);
    await methods.getChatTree('c1', { cursor: 'abc' });
    expect(pathOf(next)).toBe('/api/sessions/c1/tree?cursor=abc');
  });

  it('asks an agent’s and a chat’s pull requests by kind, children and cursor', async () => {
    const methods = createWorkGraphMethods('/api');
    const agent = serverAnswers({ items: [], nextCursor: null });
    await methods.getAgentWork('agent-1', { kind: 'pr' });
    expect(pathOf(agent)).toBe('/api/agents/agent-1/work?kind=pr');

    const chat = serverAnswers({ items: [], nextCursor: null });
    await methods.getChatWork('c1', { kind: 'pr', children: false, cursor: 'x' });
    expect(pathOf(chat)).toBe('/api/sessions/c1/work?kind=pr&children=false&cursor=x');
  });

  it('refuses an answer that is not the read’s shape', async () => {
    serverAnswers({ items: 'not a list' });
    await expect(createWorkGraphMethods('/api').getAgentWork('agent-1')).rejects.toThrow();
  });
});

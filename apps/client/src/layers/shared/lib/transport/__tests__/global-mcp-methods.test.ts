/** The global MCP server calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlobalMcpServerInput } from '@dorkos/shared/global-mcp-schemas';
import { createGlobalMcpMethods } from '../global-mcp-methods';

/** Answer every request with `status` and one JSON body (none for 204), and record what was sent. */
function answer(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(status === 204 ? null : JSON.stringify(body), { status })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL, method and body of the first request. */
function sent(fetchMock: ReturnType<typeof answer>) {
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url, method: init?.method ?? 'GET', body: init?.body };
}

afterEach(() => vi.unstubAllGlobals());

describe('createGlobalMcpMethods', () => {
  const methods = createGlobalMcpMethods('/api');

  it('posts the arguments to check and a server to add', async () => {
    let fetchMock = answer({ ok: true });
    await methods.checkGlobalMcpArgs(['--port', '3000']);
    expect(sent(fetchMock)).toEqual({
      url: '/api/mcp-servers/check-args',
      method: 'POST',
      body: '{"args":["--port","3000"]}',
    });

    const input: GlobalMcpServerInput = {
      name: 'made-up',
      connection: { transport: 'stdio', command: 'made-up-server', args: [], env: {} },
      secretNames: [],
      excludedAgents: [],
      enabled: false,
    };
    fetchMock = answer({ name: 'made-up' }, 201);
    await methods.addGlobalMcpServer(input);
    expect(sent(fetchMock)).toEqual({
      url: '/api/mcp-servers',
      method: 'POST',
      body: JSON.stringify(input),
    });
  });

  it('removes a server and undoes a standing allow with bodyless DELETEs', async () => {
    let fetchMock = answer(undefined, 204);
    await expect(methods.removeGlobalMcpServer('made-up')).resolves.toBeUndefined();
    expect(sent(fetchMock)).toEqual({
      url: '/api/mcp-servers/made-up',
      method: 'DELETE',
      body: undefined,
    });

    fetchMock = answer(undefined, 204);
    await expect(
      methods.undoGlobalMcpStandingAllow('made-up', 'agent 1', 'tool:read&write')
    ).resolves.toBeUndefined();
    expect(sent(fetchMock)).toEqual({
      url: '/api/mcp-servers/made-up/allows?agentId=agent+1&rule=tool%3Aread%26write',
      method: 'DELETE',
      body: undefined,
    });
  });
});

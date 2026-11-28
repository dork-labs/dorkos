// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectorMethods } from '../connector-methods';

function setup() {
  return createConnectorMethods('http://localhost:4242/api');
}

function stubFetch(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body)))
  );
}

function lastCall(): [string, RequestInit] {
  const call = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
  return [call[0] as string, call[1] as RequestInit];
}

beforeEach(() => vi.restoreAllMocks());

describe('connector resource transport methods', () => {
  it('negotiates authentication metadata on every search and subsequent page', async () => {
    stubFetch({ services: [], warnings: [] });
    await setup().getConnectorCatalog({ query: 'mail' });
    expect(new Headers(lastCall()[1].headers).get('x-dorkos-catalog-auth-setup')).toBe('1');
    await setup().getConnectorCatalog({ query: 'mail', cursor: 'second' });
    expect(new Headers(lastCall()[1].headers).get('x-dorkos-catalog-auth-setup')).toBe('1');
  });

  it('reads a paged account list to its last page and shows it in name order', async () => {
    const row = (label: string) => ({ connectionId: `c-${label}`, label });
    const pages = [
      { connections: [row('Work')], nextCursor: 'after/work' },
      { connections: [row('Home')], nextCursor: null },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(pages.shift())))
    );

    const { connections } = await setup().getConnectorConnections();

    expect(connections.map((connection) => connection.label)).toEqual(['Home', 'Work']);
    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/connections?cursor=after%2Fwork&limit=200'
    );
  });

  it('stops a list whose server hands back the same cursor again, with a clear error', async () => {
    stubFetch({ connections: [], nextCursor: 'again' });
    await expect(setup().getConnectorConnections()).rejects.toThrow(
      '/connectors/connections kept giving more pages; stopped after 2.'
    );
  });

  it('lists agents’ requests oldest first, as the cards have always queued', async () => {
    const asked = (requestId: string, day: number) => ({
      requestId,
      createdAt: `2026-11-0${day}T00:00:00.000Z`,
    });
    stubFetch({ requests: [asked('c', 3), asked('b', 1), asked('a', 1)], nextCursor: null });
    const requests = await setup().getConnectorAgentRequests('pending');
    expect(requests.map((request) => request.requestId)).toEqual(['a', 'b', 'c']);
  });

  it('reads agents’ requests on their owner-only route', async () => {
    stubFetch({ requests: [], nextCursor: null });
    await setup().getConnectorAgentRequests('pending');
    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/agent-requests?state=pending&limit=200'
    );

    stubFetch({ requests: [], nextCursor: null });
    await setup().getConnectorAgentRequests(undefined, 'session/a');
    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/agent-requests?sessionId=session%2Fa&limit=200'
    );
  });

  it('lets authentication start answer after the generic deadline while ordinary reads time out', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
        timeoutMs
      );
      return controller.signal;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const responseTimer = setTimeout(
              () => resolve(new Response(JSON.stringify({ state: 'pending', flowId: 'flow-a' }))),
              31_000
            );
            init?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(responseTimer);
                reject(init.signal?.reason);
              },
              { once: true }
            );
          })
      )
    );

    try {
      const authentication = setup().startConnectorAuthentication({
        providerInstanceId: 'provider-a' as never,
        toolkit: 'gmail',
        idempotencyKey: 'connect-gmail-after-thirty',
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(authentication).resolves.toMatchObject({ state: 'pending' });

      const reconnect = setup().reconnectConnectorConnection('connection-a', {
        idempotencyKey: 'reconnect-gmail-after-thirty',
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(reconnect).resolves.toMatchObject({ state: 'pending' });

      const agentRequest = setup().startConnectorAgentRequestAuthentication('request-a', {
        providerInstanceId: 'provider-a' as never,
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(agentRequest).resolves.toMatchObject({ state: 'pending' });

      const catalog = setup().getConnectorCatalog();
      const refusal = expect(catalog).rejects.toThrow('Request timed out after 30s');
      await vi.advanceTimersByTimeAsync(30_000);
      await refusal;
      expect(timeout).toHaveBeenCalledWith(75_000);
      expect(timeout).toHaveBeenCalledWith(30_000);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

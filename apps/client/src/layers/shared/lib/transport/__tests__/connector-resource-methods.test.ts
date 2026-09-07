// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectorMethods } from '../connector-methods';

function setup() {
  return createConnectorMethods('http://localhost:4242/api');
}

function stubFetch(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) })
  );
}

function lastCall(): [string, RequestInit] {
  const call = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
  return [call[0] as string, call[1] as RequestInit];
}

beforeEach(() => vi.restoreAllMocks());

describe('connector resource transport methods', () => {
  it('encodes the account-free catalog cursor and query on the canonical route', async () => {
    stubFetch({ services: [], warnings: [] });
    await setup().getConnectorCatalog({ query: 'work mail', cursor: 'next/page', limit: 25 });

    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/catalog?q=work+mail&cursor=next%2Fpage&limit=25'
    );
  });

  it('sends the durable idempotency claim on the new authentication route', async () => {
    stubFetch({ state: 'pending', flowId: 'flow-a' });
    const input = {
      providerInstanceId: 'provider-a' as never,
      toolkit: 'gmail',
      idempotencyKey: 'connect-gmail',
    };
    await setup().startConnectorAuthentication(input);

    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/connectors/connections');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
  });

  it('uses exact encoded owner, agent, and session resource paths', async () => {
    stubFetch({ connections: [] });
    await setup().getConnectorConnection('connection/a');
    expect(lastCall()[0].endsWith('/connectors/connections/connection%2Fa')).toBe(true);

    await setup().getAgentConnectorConnections('agent/a');
    expect(lastCall()[0].endsWith('/connectors/agents/agent%2Fa/connections')).toBe(true);

    await setup().getSessionConnectorConnections('session/a');
    expect(lastCall()[0].endsWith('/connectors/sessions/session%2Fa/connections')).toBe(true);
  });
});

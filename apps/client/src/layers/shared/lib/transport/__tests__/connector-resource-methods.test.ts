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

  it('negotiates authentication metadata on every search and subsequent page', async () => {
    stubFetch({ services: [], warnings: [] });
    await setup().getConnectorCatalog({ query: 'mail' });
    expect(new Headers(lastCall()[1].headers).get('x-dorkos-catalog-auth-setup')).toBe('1');
    await setup().getConnectorCatalog({ query: 'mail', cursor: 'second' });
    expect(new Headers(lastCall()[1].headers).get('x-dorkos-catalog-auth-setup')).toBe('1');
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

  it('uses owner-only agent request routes and forwards the exact decision body', async () => {
    stubFetch({ requests: [] });
    await setup().getConnectorAgentRequests('pending');
    expect(lastCall()[0]).toBe('http://localhost:4242/api/connectors/agent-requests?state=pending');

    stubFetch({ requestId: 'request/a', status: 'denied' });
    await setup().resolveConnectorAgentRequest('request/a', { decision: 'denied' });
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/connectors/agent-requests/request%2Fa/decision');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ decision: 'denied' }));
  });

  it('keeps request authentication on its exact encoded owner route', async () => {
    stubFetch({ state: 'starting', flowId: 'flow/a' });
    const input = { providerInstanceId: 'provider-a' as never, label: 'Work mail' };
    await setup().startConnectorAgentRequestAuthentication('request/a', input);
    const [startUrl, startInit] = lastCall();
    expect(startUrl).toBe(
      'http://localhost:4242/api/connectors/agent-requests/request%2Fa/authentication-flows'
    );
    expect(startInit.method).toBe('POST');
    expect(startInit.body).toBe(JSON.stringify(input));

    stubFetch({ state: 'failed', flowId: 'flow/a' });
    await setup().pollConnectorAgentRequestAuthentication('request/a', 'flow/a');
    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/agent-requests/request%2Fa/authentication-flows/flow%2Fa'
    );
  });

  it('uses exact event discovery, subscription, and source routes', async () => {
    stubFetch({ definitions: [], nextCursor: 'next/page' });
    await setup().listConnectionEventDefinitions('connection/a', 'cursor/a');
    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/connections/connection%2Fa/events/definitions?cursor=cursor%2Fa'
    );

    stubFetch({ subscriptions: [] });
    await setup().listConnectionEventSubscriptions('connection/a');
    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/connections/connection%2Fa/events/subscriptions'
    );

    const input = {
      definitionId: 'definition-a',
      filter: { channel: 'alerts' },
      agentId: 'agent-a',
      destination: { kind: 'agent' as const, id: 'agent-a' },
      requestId: '7337caa2-c19b-4715-aab4-9f33205331f1',
      manageExistingTrigger: false,
    };
    stubFetch({ id: 'subscription-a', state: 'active' });
    await setup().createConnectionEventSubscription('connection/a', input);
    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/connections/connection%2Fa/events/subscriptions'
    );
    expect(lastCall()[1]).toMatchObject({ method: 'POST', body: JSON.stringify(input) });

    stubFetch(undefined);
    await setup().deleteConnectionEventSubscription('connection/a', 'subscription/a');
    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/connections/connection%2Fa/events/subscriptions/subscription%2Fa'
    );
    expect(lastCall()[1].method).toBe('DELETE');

    stubFetch({ setupMode: 'managed', configured: false, endpoint: null, reason: null });
    await setup().getConnectionEventSource('connection/a');
    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/connections/connection%2Fa/events/source'
    );

    const source = {
      webhookSecret: 'synthetic-secret-value',
      publicOrigin: 'https://local.example',
    };
    await setup().configureConnectionEventSource('connection/a', source);
    expect(lastCall()[0]).toBe(
      'http://localhost:4242/api/connectors/connections/connection%2Fa/events/source'
    );
    expect(lastCall()[1]).toMatchObject({ method: 'PUT', body: JSON.stringify(source) });
  });
});

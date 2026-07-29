import { describe, it, expect, vi } from 'vitest';
import { FetchNangoHttpClient } from '../nango-client.js';

/** Build a client over a fetch fake that records every call it receives. */
function clientWith(responses: Array<{ status?: number; body?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses[Math.min(i, responses.length - 1)] ?? {};
    i += 1;
    return new Response(response.body ?? '{}', { status: response.status ?? 200 });
  });
  const client = new FetchNangoHttpClient({
    secretKey: 'sk-nango-secret',
    baseUrl: 'http://localhost:3003',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, calls };
}

describe('FetchNangoHttpClient — status normalization (DOR-415 nit)', () => {
  /** Drive getConnectionState with a raw status and read the normalized one. */
  async function stateFor(rawStatus: string | undefined): Promise<string> {
    const { client } = clientWith([
      { body: JSON.stringify(rawStatus === undefined ? {} : { status: rawStatus }) },
    ]);
    const state = await client.getConnectionState('cs_1');
    return state.status;
  }

  it('keeps PENDING as the explicit in-flight case', async () => {
    await expect(stateFor('PENDING')).resolves.toBe('PENDING');
    await expect(stateFor('pending')).resolves.toBe('PENDING');
  });

  it('maps the known terminal states', async () => {
    await expect(stateFor('EXPIRED')).resolves.toBe('EXPIRED');
    await expect(stateFor('ERROR')).resolves.toBe('ERROR');
    await expect(stateFor('FAILED')).resolves.toBe('ERROR');
  });

  it('defaults an UNKNOWN status to ERROR, never in-flight (a poller must not spin forever)', async () => {
    await expect(stateFor('SOMETHING_NEW')).resolves.toBe('ERROR');
    await expect(stateFor(undefined)).resolves.toBe('ERROR');
  });
});

describe('FetchNangoHttpClient — end_user identity (DOR-415 nit)', () => {
  it('sends a fresh UUID end_user.id per connect; the label stays display_name only', async () => {
    const { client, calls } = clientWith([
      { body: JSON.stringify({ data: { token: 't1' } }) },
      { body: JSON.stringify({ data: { token: 't2' } }) },
    ]);

    await client.initiateConnection({ integration: 'gmail', label: 'work' });
    await client.initiateConnection({ integration: 'gmail', label: 'work' });

    const bodies = calls.map(
      (call) =>
        JSON.parse(String(call.init.body)) as { end_user: { id: string; display_name: string } }
    );
    // Duplicate labels yield DISTINCT end-user ids…
    expect(bodies[0]!.end_user.id).not.toBe(bodies[1]!.end_user.id);
    expect(bodies[0]!.end_user.id).toMatch(/^[0-9a-f-]{36}$/);
    // …while the label rides only as the display name.
    expect(bodies[0]!.end_user.display_name).toBe('work');
    expect(bodies[1]!.end_user.display_name).toBe('work');
    expect(bodies[0]!.end_user.id).not.toBe('work');
  });
});

describe('FetchNangoHttpClient — proxyRequest (the DOR-415 wrapper seam)', () => {
  it('forwards method/path/query/body with the routing headers and the bearer key', async () => {
    const { client, calls } = clientWith([{ status: 200, body: '{"messages":[]}' }]);

    const result = await client.proxyRequest({
      method: 'POST',
      path: '/gmail/v1/users/me/messages',
      integration: 'gmail',
      connectionId: 'conn_1',
      query: { maxResults: '5' },
      body: { q: 'is:unread' },
    });

    expect(result).toEqual({ status: 200, body: '{"messages":[]}' });
    const call = calls[0]!;
    // ASSUMPTION-shaped endpoint: {base}/proxy/{path}?query
    expect(call.url).toBe('http://localhost:3003/proxy/gmail/v1/users/me/messages?maxResults=5');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-nango-secret');
    expect(headers['provider-config-key']).toBe('gmail');
    expect(headers['connection-id']).toBe('conn_1');
    expect(JSON.parse(String(call.init.body))).toEqual({ q: 'is:unread' });
  });

  it('passes an upstream error status through as a result, never a throw', async () => {
    const { client } = clientWith([{ status: 429, body: 'rate limited' }]);
    const result = await client.proxyRequest({
      method: 'GET',
      path: 'x',
      integration: 'gmail',
      connectionId: 'conn_1',
    });
    expect(result.status).toBe(429);
    expect(result.body).toBe('rate limited');
  });

  it('a caller-supplied authorization header can never displace the secret-key bearer', async () => {
    const { client, calls } = clientWith([{ status: 200 }]);
    await client.proxyRequest({
      method: 'GET',
      path: 'x',
      integration: 'gmail',
      connectionId: 'conn_1',
      headers: { authorization: 'Bearer attacker', 'connection-id': 'conn_other' },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-nango-secret');
    expect(headers['connection-id']).toBe('conn_1');
  });
});

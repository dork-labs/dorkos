/**
 * `FetchComposioHttpClient` against the REAL Composio v3.1 envelopes (docs read
 * 2026-07-29; error envelope + auth header verified live). These fixtures are
 * byte-shaped like the published API reference — the original spike-derived
 * shapes parsed a real response into an EMPTY list, which is exactly the
 * silent dead-grid failure this file pins against recurring.
 */
import { describe, it, expect, vi } from 'vitest';
import { ComposioApiError, FetchComposioHttpClient } from '../composio-client.js';

/** Build a client over a fetch fake that replays scripted responses in order. */
function clientWith(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses[Math.min(i, responses.length - 1)] ?? {};
    i += 1;
    const body =
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {});
    return new Response(body, { status: response.status ?? 200 });
  });
  const client = new FetchComposioHttpClient({
    apiKey: 'ak-project-key',
    userId: 'dorkos-operator',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, calls };
}

/** One toolkit item exactly as the v3.1 reference shapes it. */
function toolkitItem(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    slug,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    auth_schemes: ['OAUTH2'],
    composio_managed_auth_schemes: ['OAUTH2'],
    no_auth: false,
    meta: { description: '…', logo: '…' },
    ...overrides,
  };
}

describe('listToolkits — the real v3.1 envelope', () => {
  it('parses items with array-shaped auth_schemes (the founder-facing regression)', async () => {
    const { client, calls } = clientWith([
      {
        body: {
          items: [toolkitItem('gmail'), toolkitItem('slack')],
          next_cursor: null,
          total_pages: 1,
        },
      },
    ]);

    const toolkits = await client.listToolkits();
    expect(toolkits).toEqual([
      { slug: 'gmail', name: 'Gmail', authScheme: 'OAUTH2' },
      { slug: 'slack', name: 'Slack', authScheme: 'OAUTH2' },
    ]);
    expect(calls[0]!.url).toContain('/api/v3.1/toolkits');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ak-project-key');
  });

  it('maps no_auth toolkits to NO_AUTH', async () => {
    const { client } = clientWith([
      {
        body: {
          items: [toolkitItem('hackernews', { no_auth: true, auth_schemes: [] })],
          next_cursor: null,
        },
      },
    ]);
    const toolkits = await client.listToolkits();
    expect(toolkits[0]!.authScheme).toBe('NO_AUTH');
  });

  it('follows next_cursor pagination until the listing is complete', async () => {
    const { client, calls } = clientWith([
      { body: { items: [toolkitItem('gmail')], next_cursor: 'cursor-2' } },
      { body: { items: [toolkitItem('slack')], next_cursor: null } },
    ]);
    const toolkits = await client.listToolkits();
    expect(toolkits.map((tk) => tk.slug)).toEqual(['gmail', 'slack']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('cursor=cursor-2');
  });

  it('throws a ComposioApiError carrying the API message on a 401 — never an empty list', async () => {
    // Byte-shaped like the LIVE 401 observed on first contact (2026-07-29):
    // the composio CLI's uak_… user key is not a project API key.
    const { client } = clientWith([
      {
        status: 401,
        body: {
          error: {
            message: 'Invalid API key: uak**SGn9',
            code: 801,
            slug: 'APIKey_InvalidAPIKey',
            status: 401,
            suggested_fix: 'Please check you are using a valid API key.',
          },
        },
      },
    ]);
    await expect(client.listToolkits()).rejects.toMatchObject({
      name: 'ComposioApiError',
      status: 401,
      message:
        'Composio request failed (401): Invalid API key: uak**SGn9 Please check you are using a valid API key.',
    });
  });
});

describe('initiateConnection — auth-config resolution + the real create shape', () => {
  it('resolves an existing auth config, then creates the account with { auth_config, connection }', async () => {
    const { client, calls } = clientWith([
      // GET /auth_configs?toolkit_slug=gmail
      { body: { items: [{ id: 'ac_existing', is_disabled: false }] } },
      // POST /connected_accounts
      {
        body: {
          id: 'ca_new',
          status: 'INITIALIZING',
          redirect_url: 'https://accounts.google.com/o/oauth2/consent',
          connectionData: { val: { status: 'INITIALIZING' } },
        },
      },
    ]);

    const request = await client.initiateConnection({ toolkit: 'gmail', alias: 'work' });
    expect(request).toEqual({
      connectionRequestId: 'ca_new',
      redirectUrl: 'https://accounts.google.com/o/oauth2/consent',
    });

    expect(calls[0]!.url).toContain('/api/v3.1/auth_configs?toolkit_slug=gmail');
    expect(calls[1]!.url).toContain('/api/v3.1/connected_accounts');
    // The v3.1 create body: an AUTH CONFIG id (never a bare toolkit slug) plus
    // the user-scoped connection.
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      auth_config: { id: 'ac_existing' },
      connection: { user_id: 'dorkos-operator', alias: 'work' },
    });
  });

  it('creates a Composio-managed auth config when the toolkit has none, and caches it', async () => {
    const { client, calls } = clientWith([
      { body: { items: [] } }, // no existing auth config
      { body: { toolkit: { slug: 'gmail' }, auth_config: { id: 'ac_created' } } },
      { body: { id: 'ca_1', status: 'INITIALIZING', redirect_url: 'https://consent.example/1' } },
      // Second connect: the cached ac id skips straight to the create call.
      { body: { id: 'ca_2', status: 'INITIALIZING', redirect_url: 'https://consent.example/2' } },
    ]);

    await client.initiateConnection({ toolkit: 'gmail' });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      toolkit: { slug: 'gmail' },
      auth_config: { type: 'use_composio_managed_auth' },
    });

    await client.initiateConnection({ toolkit: 'gmail', alias: 'personal' });
    // 4 calls total: list, create-config, create-account, create-account.
    expect(calls).toHaveLength(4);
    expect(JSON.parse(String(calls[3]!.init.body)).auth_config).toEqual({ id: 'ac_created' });
  });

  it('falls back to connectionData.val.redirectUrl when redirect_url is null', async () => {
    const { client } = clientWith([
      { body: { items: [{ id: 'ac_1' }] } },
      {
        body: {
          id: 'ca_1',
          status: 'INITIALIZING',
          redirect_url: null,
          connectionData: { val: { redirectUrl: 'https://consent.example/fallback' } },
        },
      },
    ]);
    const request = await client.initiateConnection({ toolkit: 'gmail' });
    expect(request.redirectUrl).toBe('https://consent.example/fallback');
  });
});

describe('getConnectionState + status normalization', () => {
  it('reads the object-shaped toolkit and treats INITIALIZING as in-flight', async () => {
    const { client } = clientWith([
      { body: { id: 'ca_1', status: 'INITIALIZING', toolkit: { slug: 'gmail' } } },
    ]);
    await expect(client.getConnectionState('ca_1')).resolves.toEqual({ status: 'INITIATED' });
  });

  it('resolves an ACTIVE account with the toolkit slug unwrapped', async () => {
    const { client } = clientWith([
      { body: { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' }, alias: 'work' } },
    ]);
    const state = await client.getConnectionState('ca_1');
    expect(state.status).toBe('ACTIVE');
    expect(state.account).toEqual({
      connectedAccountId: 'ca_1',
      toolkit: 'gmail',
      alias: 'work',
      status: 'ACTIVE',
    });
  });

  it('fails closed on an UNKNOWN status — a poller must not spin forever', async () => {
    const { client } = clientWith([
      { body: { id: 'ca_1', status: 'SOMETHING_NEW', toolkit: { slug: 'gmail' } } },
    ]);
    await expect(client.getConnectionState('ca_1')).resolves.toMatchObject({ status: 'FAILED' });
  });
});

describe('listConnectedAccounts — the plural v3.1 filter params', () => {
  it('filters with user_ids and toolkit_slugs (not the singular spike-derived names)', async () => {
    const { client, calls } = clientWith([
      {
        body: {
          items: [
            { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' }, alias: 'work' },
            { id: 'ca_2', status: 'EXPIRED', toolkit: { slug: 'gmail' } },
          ],
        },
      },
    ]);
    const accounts = await client.listConnectedAccounts({ toolkit: 'gmail' });
    expect(accounts.map((a) => a.connectedAccountId)).toEqual(['ca_1', 'ca_2']);
    expect(accounts[1]!.status).toBe('EXPIRED');

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('user_ids')).toBe('dorkos-operator');
    expect(url.searchParams.get('toolkit_slugs')).toBe('gmail');
    expect(url.searchParams.get('user_id')).toBeNull();
    expect(url.searchParams.get('toolkit')).toBeNull();
  });
});

describe('mcpSessionForAccount — the Tool Router session', () => {
  it('pins the session to the account and returns the mcp url', async () => {
    const { client, calls } = clientWith([
      { body: { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } } },
      {
        body: {
          session_id: 'trs_1',
          mcp: { type: 'http', url: 'https://mcp.composio.example/trs_1' },
        },
      },
    ]);
    const session = await client.mcpSessionForAccount('ca_1');
    expect(session).toEqual({
      url: 'https://mcp.composio.example/trs_1',
      headers: { 'x-api-key': 'ak-project-key' },
    });
    expect(calls[1]!.url).toContain('/api/v3.1/tool_router/session');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      user_id: 'dorkos-operator',
      toolkits: ['gmail'],
      connected_accounts: { gmail: ['ca_1'] },
    });
  });

  it('resolves null for a non-ACTIVE account without minting a session', async () => {
    const { client, calls } = clientWith([
      { body: { id: 'ca_1', status: 'EXPIRED', toolkit: { slug: 'gmail' } } },
    ]);
    await expect(client.mcpSessionForAccount('ca_1')).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('degrades a 404 to null (no session for this account), never a throw', async () => {
    const { client } = clientWith([{ status: 404, body: { error: { message: 'not found' } } }]);
    await expect(client.mcpSessionForAccount('ca_gone')).resolves.toBeNull();
  });
});

describe('deleteConnectedAccount', () => {
  it('treats a 404 as idempotent success and surfaces other failures', async () => {
    const { client } = clientWith([{ status: 404, body: { error: { message: 'gone' } } }]);
    await expect(client.deleteConnectedAccount('ca_gone')).resolves.toBeUndefined();

    const { client: failing } = clientWith([
      { status: 500, body: { error: { message: 'server error' } } },
    ]);
    await expect(failing.deleteConnectedAccount('ca_1')).rejects.toBeInstanceOf(ComposioApiError);
  });
});

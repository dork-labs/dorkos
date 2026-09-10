import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ComposioManagedAccountClient,
  ComposioManagedAccountError,
} from '../managed-account-client.js';

interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
}

const openFixtures: Array<{ close: () => Promise<void> }> = [];

async function fixture(
  handle: (request: SeenRequest, response: ServerResponse) => void | Promise<void>
): Promise<{ baseUrl: string; requests: SeenRequest[] }> {
  const requests: SeenRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const seen: SeenRequest = {
      method: request.method ?? 'GET',
      path: new URL(request.url ?? '/', 'http://fixture').pathname,
      query: new URL(request.url ?? '/', 'http://fixture').searchParams,
      headers: request.headers,
      body: text ? JSON.parse(text) : null,
    };
    requests.push(seen);
    await handle(seen, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  openFixtures.push({
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      );
    },
  });
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function account() {
  return {
    id: 'ca_private_1',
    user_id: 'tenant:owner-1',
    toolkit: { slug: 'github' },
    auth_config: { id: 'ac_github' },
    status: 'ACTIVE',
    state: { authScheme: 'OAUTH2', val: {} },
    data: {},
    params: {},
    status_reason: null,
    is_disabled: false,
    created_at: '2026-09-06T00:00:00.000Z',
    updated_at: '2026-09-06T00:00:00.000Z',
  };
}

afterEach(async () => {
  await Promise.all(openFixtures.splice(0).map((entry) => entry.close()));
});

describe('ComposioManagedAccountClient', () => {
  it('bounds account-link creation at the SDK boundary', async () => {
    const client = new ComposioManagedAccountClient({ apiKey: 'project-key' });
    const create = vi.fn(async () => ({
      connected_account_id: 'ca_private_1',
      redirect_url: 'https://accounts.example.test/authorize',
    }));
    const sdk = (
      client as unknown as {
        _client: { link: { create: typeof create } };
      }
    )._client;
    sdk.link.create = create;
    const signal = new AbortController().signal;

    await client.createLink({
      providerUserId: 'tenant:owner-1',
      authConfigId: 'ac_github',
      signal,
    });

    expect(create).toHaveBeenCalledWith(
      { user_id: 'tenant:owner-1', auth_config_id: 'ac_github' },
      { signal, timeout: 15_000 }
    );
  });

  it('creates one exact provider-user/auth-config link without preliminary account lookup', async () => {
    const local = await fixture((request, response) => {
      expect(request.path).toBe('/api/v3.1/connected_accounts/link');
      json(response, 200, {
        connected_account_id: 'ca_private_1',
        redirect_url: 'https://accounts.example.test/authorize',
      });
    });
    const client = new ComposioManagedAccountClient({
      apiKey: 'project-key',
      baseUrl: local.baseUrl,
    });

    await expect(
      client.createLink({
        providerUserId: 'tenant:owner-1',
        authConfigId: 'ac_github',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({
      connectedAccountId: 'ca_private_1',
      redirectUrl: 'https://accounts.example.test/authorize',
    });
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0].body).toEqual({
      user_id: 'tenant:owner-1',
      auth_config_id: 'ac_github',
    });
  });

  it('marks caller cancellation after the link POST dispatch as outcome unknown', async () => {
    const controller = new AbortController();
    const local = await fixture((_request, _response) => {
      controller.abort(new DOMException('The operation was aborted.', 'AbortError'));
    });
    const client = new ComposioManagedAccountClient({
      apiKey: 'project-key',
      baseUrl: local.baseUrl,
    });

    await expect(
      client.createLink({
        providerUserId: 'tenant:owner-1',
        authConfigId: 'ac_github',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(local.requests).toHaveLength(1);
  });

  it('normalizes only exact private account facts', async () => {
    const local = await fixture((_request, response) =>
      json(response, 200, { ...account(), secret: 'must-not-survive' })
    );
    const client = new ComposioManagedAccountClient({
      apiKey: 'project-key',
      baseUrl: local.baseUrl,
    });

    await expect(client.getAccount('ca_private_1', new AbortController().signal)).resolves.toEqual({
      connectedAccountId: 'ca_private_1',
      providerUserId: 'tenant:owner-1',
      toolkit: 'github',
      authConfigId: 'ac_github',
      status: 'ACTIVE',
    });
    expect(
      JSON.stringify(await client.getAccount('ca_private_1', new AbortController().signal))
    ).not.toContain('must-not-survive');
  });

  it('redeems an opaque session only at the fixed completion endpoint', async () => {
    const local = await fixture((request, response) => {
      json(response, 200, { connected_account_id: 'ca_private_1', toolkit_slug: 'github' });
      expect(request.path).toBe('/api/v3.1/connected_accounts/complete_auth');
    });
    const client = new ComposioManagedAccountClient({
      apiKey: 'project-key',
      baseUrl: local.baseUrl,
    });

    await expect(
      client.completeAuth({
        sessionUri: 'https://attacker.invalid/not-a-destination',
        providerUserId: 'tenant:owner-1',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ connectedAccountId: 'ca_private_1', toolkit: 'github' });
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0].headers['x-api-key']).toBe('project-key');
    expect(local.requests[0].body).toEqual({
      session_uri: 'https://attacker.invalid/not-a-destination',
      user_id: 'tenant:owner-1',
    });
  });

  it('does not retry an ambiguous provider completion or expose its body', async () => {
    const local = await fixture((_request, response) =>
      json(response, 503, { error: 'private provider detail' })
    );
    const client = new ComposioManagedAccountClient({
      apiKey: 'project-key',
      baseUrl: local.baseUrl,
    });

    const error = await client
      .completeAuth({
        sessionUri: 'session-secret',
        providerUserId: 'tenant:owner-1',
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ComposioManagedAccountError);
    expect(error).toMatchObject({ code: 'outcome_unknown', status: 503 });
    expect(String(error)).not.toContain('private provider detail');
    expect(String(error)).not.toContain('session-secret');
    expect(local.requests).toHaveLength(1);
  });

  it('consumes a pre-aborted signal before allocating provider work', async () => {
    const local = await fixture((_request, response) => json(response, 500, {}));
    const client = new ComposioManagedAccountClient({
      apiKey: 'project-key',
      baseUrl: local.baseUrl,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.createLink({
        providerUserId: 'tenant:owner-1',
        authConfigId: 'ac_github',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(
      client.completeAuth({
        sessionUri: 'session-secret',
        providerUserId: 'tenant:owner-1',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(local.requests).toHaveLength(0);
  });

  it('deletes one exact connected account with no retry', async () => {
    const local = await fixture((_request, response) => json(response, 200, { status: 'success' }));
    const client = new ComposioManagedAccountClient({
      apiKey: 'project-key',
      baseUrl: local.baseUrl,
    });

    await client.deleteAccount('ca_private_1', new AbortController().signal);
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0]).toMatchObject({
      method: 'DELETE',
      path: '/api/v3.1/connected_accounts/ca_private_1',
    });
  });

  it('treats an already-absent connected account as completed cleanup', async () => {
    const local = await fixture((_request, response) =>
      json(response, 404, { error: 'private provider detail' })
    );
    const client = new ComposioManagedAccountClient({
      apiKey: 'project-key',
      baseUrl: local.baseUrl,
    });

    await expect(
      client.deleteAccount('ca_private_1', new AbortController().signal)
    ).resolves.toBeUndefined();
    expect(local.requests).toHaveLength(1);
  });
});

describe('hosted authentication wire contracts', () => {
  it('creates two separate links for the same user/config with no wrapper duplicate guard', async () => {
    let count = 0;
    const local = await fixture((request, response) => {
      expect(request.path).toBe('/api/v3.1/connected_accounts/link');
      expect(request.body).toEqual({ user_id: 'owner', auth_config_id: 'ac_managed' });
      json(response, 201, {
        connected_account_id: `ca_${++count}`,
        redirect_url: 'https://accounts.example.test/link',
      });
    });
    const client = new ComposioManagedAccountClient({
      apiKey: 'synthetic',
      baseUrl: local.baseUrl,
    });
    const input = {
      providerUserId: 'owner',
      authConfigId: 'ac_managed',
      signal: new AbortController().signal,
    };
    expect((await client.createLink(input)).connectedAccountId).toBe('ca_1');
    expect((await client.createLink(input)).connectedAccountId).toBe('ca_2');
    expect(local.requests).toHaveLength(2);
  });

  it.each([
    ['API_KEY', { api_key: 'synthetic-api-key', subdomain: 'company' }],
    ['BEARER_TOKEN', { token: 'synthetic-bearer' }],
    ['BASIC', { username: 'synthetic-user', password: 'synthetic-password' }],
    ['NO_AUTH', {}],
  ] as const)(
    'uses the actual pinned %s account-create wire without following field URLs',
    async (scheme, fields) => {
      const local = await fixture((request, response) => {
        expect(request.path).toBe('/api/v3.1/connected_accounts');
        expect(request.method).toBe('POST');
        expect(request.body).toEqual({
          auth_config: { id: 'ac_exact' },
          connection: {
            user_id: 'owner_exact',
            state: { authScheme: scheme, val: { ...fields, status: 'ACTIVE' } },
          },
        });
        json(response, 201, { id: 'ca_exact', credentials: 'must-not-survive' });
      });
      const client = new ComposioManagedAccountClient({
        apiKey: 'synthetic',
        baseUrl: local.baseUrl,
      });
      const result = await client.createFieldAccount({
        providerUserId: 'owner_exact',
        authConfigId: 'ac_exact',
        descriptor: {
          toolkit: 'synthetic',
          scheme,
          kind: scheme === 'NO_AUTH' ? 'none' : 'fields',
          source: 'account-fields',
          fields: Object.keys(fields).map((name) => ({
            name,
            label: name,
            description: '',
            type: 'string' as const,
            secret: name !== 'subdomain',
            required: true,
          })),
        },
        fields,
        signal: new AbortController().signal,
      });
      expect(result).toEqual({ connectedAccountId: 'ca_exact' });
      expect(local.requests).toHaveLength(1);
    }
  );

  it('rejects OAuth and undeclared secret fields before dispatch; ambiguous create never retries', async () => {
    const local = await fixture((_request, response) =>
      json(response, 503, { error: 'SENTINEL-private-key' })
    );
    const client = new ComposioManagedAccountClient({
      apiKey: 'synthetic',
      baseUrl: local.baseUrl,
    });
    const input = {
      providerUserId: 'owner',
      authConfigId: 'ac',
      descriptor: {
        toolkit: 'test',
        scheme: 'API_KEY' as const,
        kind: 'fields' as const,
        source: 'account-fields' as const,
        fields: [
          {
            name: 'api_key',
            label: 'Key',
            description: '',
            type: 'password' as const,
            required: true,
            secret: true,
          },
        ],
      },
      fields: { api_key: 'SENTINEL-private-key' },
      signal: new AbortController().signal,
    };
    await expect(
      client.createFieldAccount({
        ...input,
        descriptor: { ...input.descriptor, kind: 'oauth', scheme: 'OAUTH2' },
      })
    ).rejects.toThrow('Account details do not match');
    await expect(
      client.createFieldAccount({
        ...input,
        fields: { ...input.fields, attacker: 'SENTINEL-private-key' },
      })
    ).rejects.toThrow('Account details do not match');
    expect(local.requests).toHaveLength(0);
    const error = await client.createFieldAccount(input).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'outcome_unknown' });
    expect(String(error)).not.toContain('SENTINEL');
    expect(local.requests).toHaveLength(1);
  });
});

describe('authentication configuration SDK wire', () => {
  it('classifies malformed toolkit metadata without exposing provider values', async () => {
    const privateValue = 'PRIVATE_TOOLKIT_RESPONSE';
    const local = await fixture((_request, response) =>
      json(response, 200, { slug: privateValue, auth_config_details: 'invalid' })
    );
    const client = new ComposioManagedAccountClient({
      apiKey: 'synthetic-project',
      baseUrl: local.baseUrl,
    });

    const error = await client
      .getToolkitAuthentication('gmail', new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'invalid_provider_response', status: undefined });
    expect(String(error)).not.toContain(privateValue);
    expect(local.requests).toHaveLength(1);
  });

  it('reads exact declared metadata and creates the managed default without developer credentials', async () => {
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/toolkits/gmail')
        return json(response, 200, {
          slug: 'gmail',
          enabled: true,
          composio_managed_auth_schemes: ['OAUTH2'],
          auth_config_details: [],
        });
      if (request.method === 'POST')
        return json(response, 200, {
          auth_config: { id: 'ac_new', auth_scheme: 'OAUTH2', is_composio_managed: true },
          toolkit: { slug: 'gmail' },
        });
      return json(response, 200, {
        id: 'ac_new',
        name: 'dorkos-default-exact',
        toolkit: { slug: 'gmail' },
        auth_scheme: 'OAUTH2',
        status: 'ENABLED',
        is_composio_managed: true,
        type: 'default',
        tool_access_config: {
          tools_for_connected_account_creation: [],
          tools_available_for_execution: [],
        },
        is_enabled_for_tool_router: false,
        credentials: { scopes: ['read', 'read'] },
        shared_credentials: {},
        proxy_config: null,
        expected_input_fields: [{ default: 'PRIVATE_ENVELOPE' }],
      });
    });
    const client = new ComposioManagedAccountClient({
      apiKey: 'synthetic-project',
      baseUrl: local.baseUrl,
    });
    expect(
      await client.getToolkitAuthentication('gmail', new AbortController().signal)
    ).toMatchObject({ toolkit: 'gmail', managedOAuth2: true });
    await expect(
      client.createAuthenticationConfiguration({
        name: 'dorkos-default-exact',
        descriptor: {
          toolkit: 'gmail',
          scheme: 'OAUTH2',
          kind: 'oauth',
          source: 'managed',
          fields: [],
        },
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ id: 'ac_new' });
    expect(local.requests[1].path).toBe('/api/v3.1/auth_configs');
    expect(local.requests[1].body).toEqual({
      toolkit: { slug: 'gmail' },
      auth_config: {
        type: 'use_composio_managed_auth',
        name: 'dorkos-default-exact',
        is_enabled_for_tool_router: false,
      },
    });
    const config = await client.getAuthenticationConfiguration(
      'ac_new',
      new AbortController().signal
    );
    expect(config).toMatchObject({ id: 'ac_new', scheme: 'OAUTH2', enabled: true, managed: true });
    expect(JSON.stringify(config)).not.toContain('PRIVATE_ENVELOPE');
    expect(config.policy).toEqual({
      type: 'default',
      scopes: ['read'],
      userScopes: [],
      credentialsEmpty: false,
      routerEnabled: false,
    });
  });
  it.each(['API_KEY', 'BEARER_TOKEN', 'BASIC', 'NO_AUTH'] as const)(
    'creates a %s blueprint with an empty project credential payload',
    async (scheme) => {
      const local = await fixture((_request, response) =>
        json(response, 200, { auth_config: { id: 'ac_fields' }, toolkit: { slug: 'synthetic' } })
      );
      const client = new ComposioManagedAccountClient({
        apiKey: 'synthetic-project',
        baseUrl: local.baseUrl,
      });
      await client.createAuthenticationConfiguration({
        name: 'dorkos-default-fields',
        descriptor: {
          toolkit: 'synthetic',
          scheme,
          kind: scheme === 'NO_AUTH' ? 'none' : 'fields',
          source: 'account-fields',
          fields: [],
        },
        signal: new AbortController().signal,
      });
      expect(local.requests).toHaveLength(1);
      expect(local.requests[0].body).toEqual({
        toolkit: { slug: 'synthetic' },
        auth_config: {
          type: 'use_custom_auth',
          authScheme: scheme,
          name: 'dorkos-default-fields',
          credentials: {},
          is_enabled_for_tool_router: false,
        },
      });
    }
  );
  it('passes exact candidate filters and cursors through the real SDK without private envelopes', async () => {
    const local = await fixture((request, response) => {
      expect(request.method).toBe('GET');
      expect(request.path).toBe('/api/v3.1/auth_configs');
      expect(Object.fromEntries(request.query)).toEqual({
        toolkit_slug: 'gmail',
        search: 'exact name',
        limit: '50',
        show_disabled: 'true',
        cursor: 'page-two',
      });
      return json(response, 200, {
        items: [
          {
            id: 'ac_exact',
            name: 'exact name',
            toolkit: { slug: 'gmail' },
            auth_scheme: 'OAUTH2',
            status: 'ENABLED',
            is_composio_managed: true,
            credentials: { token: 'PRIVATE_LIST_SECRET' },
          },
        ],
        next_cursor: 'page-three',
      });
    });
    const client = new ComposioManagedAccountClient({
      apiKey: 'synthetic',
      baseUrl: local.baseUrl,
    });
    const page = await client.listAuthenticationConfigurations({
      toolkit: 'gmail',
      name: 'exact name',
      cursor: 'page-two',
      signal: new AbortController().signal,
    });
    expect(page.nextCursor).toBe('page-three');
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('PRIVATE_LIST_SECRET');
  });

  it('does not retry an ambiguous config POST and does not expose the error body', async () => {
    const local = await fixture((_request, response) =>
      json(response, 503, { secret: 'PRIVATE_ERROR' })
    );
    const client = new ComposioManagedAccountClient({
      apiKey: 'synthetic-project',
      baseUrl: local.baseUrl,
    });
    await expect(
      client.createAuthenticationConfiguration({
        name: 'dorkos-default',
        descriptor: {
          toolkit: 'gmail',
          scheme: 'OAUTH2',
          kind: 'oauth',
          source: 'managed',
          fields: [],
        },
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({
      code: 'outcome_unknown',
      message: 'Account setup could not be confirmed.',
    });
    expect(local.requests).toHaveLength(1);
  });
});

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ComposioManagedAccountClient,
  ComposioManagedAccountError,
} from '../managed-account-client.js';

interface SeenRequest {
  method: string;
  path: string;
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
      headers: request.headers,
      body: text ? JSON.parse(text) : null,
    };
    requests.push(seen);
    await handle(seen, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  openFixtures.push({
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
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

/** @vitest-environment node */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ComposioSdkClient } from '@dorkos/connector-providers/composio';
import { afterEach, describe, expect, it } from 'vitest';

import type { ManagedConnectorConfig } from '../config';
import { listManagedConnectorCatalog } from '../discovery-service';

const config: ManagedConnectorConfig = {
  enabled: true,
  liveReady: true,
  projectApiKey: 'project-fixture',
  callbackOrigin: 'https://dorkos.example',
  authConfigByToolkit: {},
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A stand-in Composio API that records each toolkit listing's query string. */
async function composioStub(): Promise<{ baseUrl: string; queries: Record<string, string>[] }> {
  const queries: Record<string, string>[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.invalid');
    if (url.pathname !== '/api/v3.1/toolkits') {
      response.writeHead(599).end();
      return;
    }
    queries.push(Object.fromEntries(url.searchParams.entries()));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        current_page: 1,
        total_items: 1,
        total_pages: 1,
        items: [
          {
            deprecated: { toolkit_id: 'github' },
            is_local_toolkit: false,
            meta: {
              categories: [],
              created_at: '2026-09-01T00:00:00.000Z',
              description: 'GitHub',
              logo: 'https://logos.composio.dev/api/github',
              tools_count: 3,
              triggers_count: 0,
              updated_at: '2026-09-01T00:00:00.000Z',
            },
            name: 'GitHub',
            slug: 'github',
            type: 'native',
            auth_schemes: ['OAUTH2'],
            composio_managed_auth_schemes: ['OAUTH2'],
            no_auth: false,
          },
        ],
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, queries };
}

describe('hosted catalog search', () => {
  it('sends a caller’s query to Composio as its search, as the public contract promises', async () => {
    const stub = await composioStub();
    const operations = new ComposioSdkClient({
      apiKey: 'project-fixture',
      serverUserId: 'server-user',
      baseUrl: stub.baseUrl,
    });

    const page = await listManagedConnectorCatalog({
      operations,
      config,
      rawRequest: { version: 1, query: 'git', limit: 20 },
      signal: AbortSignal.timeout(5_000),
    });

    expect(stub.queries).toHaveLength(1);
    expect(stub.queries[0]).toMatchObject({ search: 'git', limit: '20' });
    expect(page.toolkits.map((toolkit) => toolkit.slug)).toEqual(['github']);
  });

  it('sends no search when the caller asks for none', async () => {
    const stub = await composioStub();
    const operations = new ComposioSdkClient({
      apiKey: 'project-fixture',
      serverUserId: 'server-user',
      baseUrl: stub.baseUrl,
    });

    await listManagedConnectorCatalog({
      operations,
      config,
      rawRequest: { version: 1, limit: 20 },
      signal: AbortSignal.timeout(5_000),
    });

    expect(stub.queries[0]).not.toHaveProperty('search');
  });
});

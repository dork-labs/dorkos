import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectorOperationRevision,
  ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-schemas';
import { ComposioSdkClient } from '../sdk-client.js';

const API_KEY = 'sk_fixture_private';
const SERVER_USER_ID = 'server-user-fixture';
const TOOLKIT_VERSION = '20260902_00';
const INSTANCE_ID = 'composio:personal' as ConnectorProviderInstanceId;

interface SeenRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  apiKey: string | undefined;
}

interface Fixture {
  baseUrl: string;
  requests: SeenRequest[];
  close(): Promise<void>;
}

const openFixtures: Fixture[] = [];

function tool(slug: string, tags: string[]) {
  return {
    available_versions: [TOOLKIT_VERSION],
    deprecated: {
      available_versions: [TOOLKIT_VERSION],
      display_name: slug,
      is_deprecated: false,
      toolkit: { logo: 'https://assets.fixture.invalid/github.svg' },
      version: TOOLKIT_VERSION,
    },
    description: `Description for ${slug}`,
    human_description: `Description for ${slug}`,
    input_parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    is_deprecated: false,
    name: slug,
    no_auth: false,
    output_parameters: { type: 'object' },
    scope_requirements: { all_of: [] },
    scopes: [],
    slug,
    tags,
    toolkit: {
      logo: 'https://assets.fixture.invalid/github.svg',
      name: 'GitHub',
      slug: 'github',
    },
    version: TOOLKIT_VERSION,
  };
}

function toolkit() {
  return {
    composio_managed_auth: [],
    deprecated: { rawProxyInfoByAuthSchemes: [], toolkitId: 'github' },
    enabled: true,
    is_local_toolkit: false,
    meta: {
      available_versions: [TOOLKIT_VERSION],
      categories: [],
      created_at: '2026-09-01T00:00:00.000Z',
      description: 'GitHub',
      logo: 'https://assets.fixture.invalid/github.svg',
      tools_count: 3,
      triggers_count: 0,
      updated_at: '2026-09-01T00:00:00.000Z',
      version: TOOLKIT_VERSION,
      app_url: 'https://github.com',
    },
    name: 'GitHub',
    slug: 'github',
    type: 'native',
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function fixture(
  handle: (request: SeenRequest, response: ServerResponse) => void | Promise<void>
): Promise<Fixture> {
  const requests: SeenRequest[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const seen: SeenRequest = {
      method: request.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body: await readBody(request),
      apiKey: request.headers['x-api-key'] as string | undefined,
    };
    requests.push(seen);
    await handle(seen, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const result: Fixture = {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  openFixtures.push(result);
  return result;
}

function operation(
  overrides: Partial<ConnectorOperationRevision> = {}
): ConnectorOperationRevision {
  return {
    id: 'revision-1',
    providerInstanceId: INSTANCE_ID,
    toolkit: 'github',
    operationSlug: 'GITHUB_CREATE_ISSUE',
    toolkitVersion: TOOLKIT_VERSION,
    schemaHash: 'sha256:fixture',
    capabilityClassification: 'destructive',
    retryPolicy: 'never',
    inputSchema: { type: 'object' },
    discoveredAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function client(baseUrl: string): ComposioSdkClient {
  return new ComposioSdkClient({
    apiKey: API_KEY,
    serverUserId: SERVER_USER_ID,
    baseUrl,
  });
}

afterEach(async () => {
  await Promise.all(openFixtures.splice(0).map((entry) => entry.close()));
});

describe('ComposioSdkClient', () => {
  it('returns one bounded account-free toolkit page with exact cursor state', async () => {
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/toolkits') {
        return json(response, 200, {
          current_page: 1,
          total_items: 2,
          total_pages: 2,
          next_cursor: 'toolkit-page-2',
          items: [
            {
              deprecated: { toolkit_id: 'github' },
              is_local_toolkit: false,
              meta: {
                categories: [],
                created_at: '2026-09-01T00:00:00.000Z',
                description: 'GitHub',
                logo: 'https://assets.fixture.invalid/github.svg',
                tools_count: 3,
                triggers_count: 0,
                updated_at: '2026-09-01T00:00:00.000Z',
              },
              name: 'GitHub',
              slug: 'github',
              type: 'native',
              auth_schemes: ['OAUTH2'],
              no_auth: false,
            },
          ],
        });
      }
      return json(response, 599, { error: `unexpected ${request.method} ${request.path}` });
    });

    const page = await client(local.baseUrl).listToolkitPage({
      query: 'git',
      limit: 1,
      signal: new AbortController().signal,
    });
    expect(page).toEqual({
      status: 'ok',
      toolkits: [{ slug: 'github', displayName: 'GitHub', authKind: 'oauth2' }],
      nextCursor: 'toolkit-page-2',
      truncated: true,
    });
    expect(local.requests[0]?.query).toMatchObject({
      search: 'git',
      limit: '1',
      include_deprecated: 'false',
      sort_by: 'alphabetically',
    });
  });

  it('resolves a concrete toolkit version and preserves exact cursor metadata across pages', async () => {
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/toolkits/github') return json(response, 200, toolkit());
      if (request.path === '/api/v3.1/tools') {
        const cursor = request.query.cursor;
        return json(response, 200, {
          current_page: cursor ? 2 : 1,
          items: cursor
            ? [
                tool('GITHUB_CREATE_ISSUE', ['readOnlyHint', 'destructiveHint', 'openWorldHint']),
                tool('GITHUB_GENERIC_PROXY', ['openWorldHint']),
              ]
            : [tool('GITHUB_GET_REPOSITORY', ['readOnlyHint', 'idempotentHint'])],
          total_items: 3,
          total_pages: 2,
          next_cursor: cursor ? null : 'cursor/page+2=',
        });
      }
      return json(response, 599, { error: `unexpected ${request.method} ${request.path}` });
    });
    const sdk = client(local.baseUrl);

    const version = await sdk.resolveToolkitVersion('github', new AbortController().signal);
    expect(version).toEqual({ status: 'ok', toolkit: 'github', toolkitVersion: TOOLKIT_VERSION });
    if (version.status !== 'ok') throw new Error(version.reason);

    const first = await sdk.listOperationSchemas(INSTANCE_ID, {
      toolkit: 'github',
      toolkitVersion: version.toolkitVersion,
      limit: 1,
      signal: new AbortController().signal,
    });
    expect(first.page.operations).toHaveLength(1);
    expect(first.page.operations[0]).toMatchObject({
      operationSlug: 'GITHUB_GET_REPOSITORY',
      toolkitVersion: TOOLKIT_VERSION,
      capabilityClassification: 'read',
      retryPolicy: 'never',
      schemaHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(first.page).toMatchObject({ nextCursor: 'cursor/page+2=', truncated: true });

    const second = await sdk.listOperationSchemas(INSTANCE_ID, {
      toolkit: 'github',
      toolkitVersion: version.toolkitVersion,
      cursor: first.page.nextCursor,
      limit: 2,
      signal: new AbortController().signal,
    });
    expect(second.page.operations.map((entry) => entry.operationSlug)).toEqual([
      'GITHUB_CREATE_ISSUE',
    ]);
    expect(second.page.operations[0]?.capabilityClassification).toBe('destructive');
    expect(second.page.truncated).toBe(false);

    const listRequests = local.requests.filter((entry) => entry.path === '/api/v3.1/tools');
    expect(listRequests).toHaveLength(2);
    expect(listRequests[0]?.query).toMatchObject({
      toolkit_slug: 'github',
      'toolkit_versions[github]': TOOLKIT_VERSION,
      important: 'false',
      include_deprecated: 'false',
      limit: '1',
    });
    expect(listRequests[1]?.query.cursor).toBe('cursor/page+2=');
    expect(local.requests.every((entry) => entry.apiKey === API_KEY)).toBe(true);
  });

  it('sends one exact-account write and returns operation content without session metadata', async () => {
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/tools/GITHUB_CREATE_ISSUE' && request.method === 'GET') {
        return json(response, 200, tool('GITHUB_CREATE_ISSUE', ['destructiveHint']));
      }
      if (
        request.path === '/api/v3.1/tools/execute/GITHUB_CREATE_ISSUE' &&
        request.method === 'POST'
      ) {
        return json(response, 200, {
          data: { issueUrl: 'https://github.com/dork-labs/dorkos/issues/42' },
          error: null,
          successful: true,
          log_id: 'provider-log-42',
          session_info: { token: 'must-not-cross-boundary' },
        });
      }
      return json(response, 599, { error: `unexpected ${request.method} ${request.path}` });
    });

    const result = await client(local.baseUrl).execute({
      connectedAccountId: 'ca_private_exact',
      authorizeDispatch: () => true,
      operation: operation(),
      arguments: { title: 'Exact write' },
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: 'success',
      data: { issueUrl: 'https://github.com/dork-labs/dorkos/issues/42' },
      providerLogId: 'provider-log-42',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-cross-boundary');
    const writes = local.requests.filter((entry) => entry.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({
      allow_tracing: false,
      connected_account_id: 'ca_private_exact',
      arguments: { title: 'Exact write' },
      user_id: SERVER_USER_ID,
      version: TOOLKIT_VERSION,
    });
  });

  it('refuses latest and pre-aborted work before any request', async () => {
    const local = await fixture((request, response) =>
      json(response, 599, { error: `unexpected ${request.method} ${request.path}` })
    );
    const sdk = client(local.baseUrl);
    const controller = new AbortController();
    controller.abort();

    await expect(
      sdk.execute({
        connectedAccountId: 'ca_private_exact',
        authorizeDispatch: () => true,
        operation: operation(),
        arguments: {},
        signal: controller.signal,
      })
    ).resolves.toMatchObject({
      status: 'cancelled',
      code: 'CANCELLED_BEFORE_DISPATCH',
    });
    await expect(
      sdk.execute({
        connectedAccountId: 'ca_private_exact',
        authorizeDispatch: () => true,
        operation: operation({ toolkitVersion: 'latest' }),
        arguments: {},
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ status: 'error', code: 'INVALID_TOOLKIT_VERSION' });
    await expect(
      sdk.execute({
        connectedAccountId: 'ca_private_exact',
        authorizeDispatch: () => true,
        operation: operation({
          inputSchema: {
            type: 'object',
            properties: { attachment: { type: 'string', format: 'path' } },
          },
        }),
        arguments: { attachment: '/private/operator/file.txt' },
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ status: 'error', code: 'UNSUPPORTED_FILE_INPUT' });
    expect(local.requests).toEqual([]);
  });

  it('rejects the SDK raw file-uploadable schema before any provider request', async () => {
    const rawFileSchema = {
      type: 'object',
      properties: {
        attachment: {
          type: 'object',
          file_uploadable: true,
          properties: {
            name: { type: 'string' },
            mimetype: { type: 'string' },
            s3key: { type: 'string' },
          },
        },
      },
    };
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/tools/GITHUB_CREATE_ISSUE') {
        return json(response, 200, {
          ...tool('GITHUB_CREATE_ISSUE', ['destructiveHint']),
          input_parameters: rawFileSchema,
        });
      }
      if (request.path === '/api/v3.1/tools/execute/GITHUB_CREATE_ISSUE') {
        return json(response, 200, {
          data: { uploaded: true },
          error: null,
          successful: true,
          log_id: 'must-not-dispatch',
        });
      }
      return json(response, 599, { error: `unexpected ${request.method} ${request.path}` });
    });

    const result = await client(local.baseUrl).execute({
      connectedAccountId: 'ca_private_exact',
      authorizeDispatch: () => true,
      operation: operation({
        inputSchema: rawFileSchema,
      }),
      arguments: {
        attachment: {
          name: 'private.txt',
          mimetype: 'text/plain',
          s3key: 'private/provider/staging-key',
        },
      },
      signal: new AbortController().signal,
    });

    expect(local.requests).toEqual([]);
    expect(result).toMatchObject({
      status: 'error',
      code: 'UNSUPPORTED_FILE_INPUT',
      retryable: false,
    });
  });

  it('rejects repeated cursors, oversized catalogs, and pre-aborted discovery', async () => {
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/tools') {
        return json(response, 200, {
          current_page: request.query.cursor === 'missing' ? 1 : 2,
          items: [tool('GITHUB_GET_REPOSITORY', ['readOnlyHint'])],
          total_items: 1,
          total_pages: request.query.cursor === 'oversized' ? 101 : 2,
          next_cursor: request.query.cursor === 'missing' ? null : request.query.cursor,
        });
      }
      return json(response, 500, { error: { message: 'private catalog failure' } });
    });
    const sdk = client(local.baseUrl);

    await expect(
      sdk.listOperationSchemas(INSTANCE_ID, {
        toolkit: 'github',
        toolkitVersion: TOOLKIT_VERSION,
        cursor: 'repeated',
        limit: 1,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/repeated.*cursor/i);
    await expect(
      sdk.listOperationSchemas(INSTANCE_ID, {
        toolkit: 'github',
        toolkitVersion: TOOLKIT_VERSION,
        cursor: 'oversized',
        limit: 1,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/100-page safety limit/);
    await expect(
      sdk.listOperationSchemas(INSTANCE_ID, {
        toolkit: 'github',
        toolkitVersion: TOOLKIT_VERSION,
        cursor: 'missing',
        limit: 1,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/omitted the cursor/);

    const controller = new AbortController();
    controller.abort();
    await expect(sdk.resolveToolkitVersion('github', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(local.requests).toHaveLength(3);
  });

  it('does not retry a failed discovery request or disclose its provider response', async () => {
    const local = await fixture((_request, response) =>
      json(response, 500, { error: { message: 'private-catalog-sentinel' } })
    );
    const sdk = client(local.baseUrl);

    const failure = await sdk
      .resolveToolkitVersion('github', new AbortController().signal)
      .catch((error: unknown) => error);
    expect(local.requests).toHaveLength(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('private-catalog-sentinel');
  });

  it('returns unknown after an execute 500 and never retries the write', async () => {
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/tools/GITHUB_CREATE_ISSUE' && request.method === 'GET') {
        return json(response, 200, tool('GITHUB_CREATE_ISSUE', ['destructiveHint']));
      }
      if (request.path === '/api/v3.1/tools/execute/GITHUB_CREATE_ISSUE') {
        return json(response, 500, { error: { message: 'private provider failure' } });
      }
      return json(response, 599, { error: 'unexpected' });
    });

    const result = await client(local.baseUrl).execute({
      connectedAccountId: 'ca_private_exact',
      authorizeDispatch: () => true,
      operation: operation(),
      arguments: {},
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: 'outcome_unknown',
      code: 'PROVIDER_OUTCOME_UNKNOWN',
      message: 'The service may have accepted the operation, but did not confirm its outcome.',
    });
    expect(local.requests.filter((entry) => entry.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private provider failure');
  });

  it('returns cancelled when abort stops the preliminary schema read before dispatch', async () => {
    let sawSchemaRead!: () => void;
    const schemaReadSeen = new Promise<void>((resolve) => {
      sawSchemaRead = resolve;
    });
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/tools/GITHUB_CREATE_ISSUE' && request.method === 'GET') {
        sawSchemaRead();
        return;
      }
      return json(response, 599, { error: `unexpected ${request.method} ${request.path}` });
    });
    const controller = new AbortController();
    const pending = client(local.baseUrl).execute({
      connectedAccountId: 'ca_private_exact',
      authorizeDispatch: () => true,
      operation: operation(),
      arguments: {},
      signal: controller.signal,
    });

    await schemaReadSeen;
    controller.abort();

    await expect(pending).resolves.toEqual({
      status: 'cancelled',
      code: 'CANCELLED_BEFORE_DISPATCH',
      message: 'The operation was cancelled before it was sent.',
    });
    expect(local.requests.map((entry) => entry.method)).toEqual(['GET']);
  });

  it('returns a safe terminal error when the preliminary schema read fails before dispatch', async () => {
    const local = await fixture((_request, response) =>
      json(response, 500, { error: { message: 'private-schema-failure-sentinel' } })
    );

    const result = await client(local.baseUrl).execute({
      connectedAccountId: 'ca_private_exact',
      authorizeDispatch: () => true,
      operation: operation(),
      arguments: {},
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: 'error',
      code: 'PROVIDER_PRECHECK_FAILED',
      message: 'DorkOS could not verify the operation before sending it.',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('private-schema-failure-sentinel');
    expect(local.requests.length).toBeGreaterThan(0);
    expect(local.requests.every((entry) => entry.method === 'GET')).toBe(true);
  });

  it('revalidates authority after the exact schema read and before the execute POST', async () => {
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/tools/GITHUB_CREATE_ISSUE' && request.method === 'GET') {
        return json(response, 200, tool('GITHUB_CREATE_ISSUE', ['destructiveHint']));
      }
      return json(response, 599, { error: `unexpected ${request.method} ${request.path}` });
    });
    const authorizeDispatch = vi.fn().mockResolvedValue(false);

    const result = await client(local.baseUrl).execute({
      connectedAccountId: 'ca_private_exact',
      authorizeDispatch,
      operation: operation(),
      arguments: {},
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: 'error',
      code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
      message: 'Access changed before the operation was sent.',
      retryable: false,
    });
    expect(authorizeDispatch).toHaveBeenCalledTimes(1);
    expect(local.requests.map((entry) => entry.method)).toEqual(['GET']);
  });

  it('returns a stable terminal rejection without exposing the provider error envelope', async () => {
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/tools/GITHUB_CREATE_ISSUE' && request.method === 'GET') {
        return json(response, 200, tool('GITHUB_CREATE_ISSUE', ['destructiveHint']));
      }
      if (request.path === '/api/v3.1/tools/execute/GITHUB_CREATE_ISSUE') {
        return json(response, 200, {
          data: {},
          error: 'private-provider-rejection-sentinel',
          successful: false,
          log_id: 'provider-log-rejected',
        });
      }
      return json(response, 599, { error: 'unexpected' });
    });

    const result = await client(local.baseUrl).execute({
      connectedAccountId: 'ca_private_exact',
      authorizeDispatch: () => true,
      operation: operation(),
      arguments: {},
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: 'error',
      code: 'PROVIDER_REJECTED',
      message: 'The service rejected the operation.',
      retryable: false,
      providerLogId: 'provider-log-rejected',
    });
    expect(JSON.stringify(result)).not.toContain('private-provider-rejection-sentinel');
    expect(local.requests.filter((entry) => entry.method === 'POST')).toHaveLength(1);
  });

  it('returns unknown when cancellation arrives after the write was accepted', async () => {
    let sawWrite!: () => void;
    const writeSeen = new Promise<void>((resolve) => {
      sawWrite = resolve;
    });
    const local = await fixture((request, response) => {
      if (request.path === '/api/v3.1/tools/GITHUB_CREATE_ISSUE' && request.method === 'GET') {
        return json(response, 200, tool('GITHUB_CREATE_ISSUE', ['destructiveHint']));
      }
      if (request.path === '/api/v3.1/tools/execute/GITHUB_CREATE_ISSUE') {
        sawWrite();
        return;
      }
      return json(response, 599, { error: 'unexpected' });
    });
    const controller = new AbortController();
    const pending = client(local.baseUrl).execute({
      connectedAccountId: 'ca_private_exact',
      authorizeDispatch: () => true,
      operation: operation(),
      arguments: {},
      signal: controller.signal,
    });

    await writeSeen;
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: 'outcome_unknown',
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
    expect(local.requests.filter((entry) => entry.method === 'POST')).toHaveLength(1);
  });
});

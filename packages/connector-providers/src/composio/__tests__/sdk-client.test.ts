import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectorOperationRevision,
  ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-schemas';
import { createComposioHostedClients } from '../hosted-client-factory.js';
import { ComposioSdkClient, normalizeComposioCatalogAuthentication } from '../sdk-client.js';

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
              composio_managed_auth_schemes: ['OAUTH2'],
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
      toolkits: [
        {
          slug: 'github',
          displayName: 'GitHub',
          authKind: 'oauth2',
          authenticationSetup: {
            kind: 'oauth',
            source: 'managed',
            scheme: 'OAUTH2',
            requiresAccountFields: false,
          },
        },
      ],
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

  it('normalizes only declared supported catalog authentication methods', () => {
    expect(
      normalizeComposioCatalogAuthentication({
        auth_schemes: ['API_KEY', 'OAUTH2'],
        composio_managed_auth_schemes: ['OAUTH2'],
      })
    ).toEqual({
      authKind: 'oauth2',
      authenticationSetup: {
        kind: 'oauth',
        source: 'managed',
        scheme: 'OAUTH2',
        requiresAccountFields: false,
      },
    });

    expect(
      normalizeComposioCatalogAuthentication({
        auth_schemes: ['BASIC', 'BEARER_TOKEN', 'API_KEY'],
      })
    ).toEqual({
      authKind: 'api-key',
      authenticationSetup: {
        kind: 'fields',
        source: 'account-fields',
        scheme: 'API_KEY',
        requiresAccountFields: true,
      },
    });

    expect(normalizeComposioCatalogAuthentication({ auth_schemes: ['BEARER_TOKEN'] })).toEqual({
      authKind: 'api-key',
      authenticationSetup: {
        kind: 'fields',
        source: 'account-fields',
        scheme: 'BEARER_TOKEN',
        requiresAccountFields: true,
      },
    });
    expect(normalizeComposioCatalogAuthentication({ auth_schemes: ['BASIC'] })).toEqual({
      authKind: 'api-key',
      authenticationSetup: {
        kind: 'fields',
        source: 'account-fields',
        scheme: 'BASIC',
        requiresAccountFields: true,
      },
    });
    expect(normalizeComposioCatalogAuthentication({ no_auth: true })).toEqual({
      authKind: 'none',
      authenticationSetup: {
        kind: 'none',
        source: 'account-fields',
        scheme: 'NO_AUTH',
        requiresAccountFields: false,
      },
    });
    expect(
      normalizeComposioCatalogAuthentication({
        auth_schemes: ['OAUTH1'],
        composio_managed_auth_schemes: ['OAUTH1'],
      })
    ).toEqual({
      authKind: 'none',
      authenticationSetup: {
        kind: 'unsupported',
        source: 'unsupported',
        scheme: 'OAUTH1',
        requiresAccountFields: false,
      },
    });
    expect(normalizeComposioCatalogAuthentication({})).toEqual({
      authKind: 'none',
      authenticationSetup: {
        kind: 'unsupported',
        source: 'unsupported',
        requiresAccountFields: false,
      },
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
      'GITHUB_GENERIC_PROXY',
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

  // Tag shapes follow Composio's documented verdicts (only `…Hint` tags count): every action carries at
  // least one of readOnlyHint / createHint / updateHint / destructiveHint, and
  // an irreversible update carries updateHint AND destructiveHint.
  it.each([
    // Makes or changes something, nothing removed: the "Read and write" tier.
    ['GMAIL_SEND_EMAIL', ['important', 'openWorldHint', 'createHint'], 'write'],
    ['GMAIL_CREATE_EMAIL_DRAFT', ['important', 'openWorldHint', 'createHint'], 'write'],
    ['GOOGLECALENDAR_CREATE_EVENT', ['createHint'], 'write'],
    // Only audited apps (Gmail, Google Calendar) get a write tier; every other
    // app's create and update actions stay one at a time.
    ['GITHUB_UPDATE_AN_ISSUE', ['updateHint', 'idempotentHint'], 'destructive'],
    ['GOOGLEDRIVE_CREATE_FILE', ['createHint'], 'destructive'],
    // DorkOS keeps account-reach actions out of levels, by name for future tools too.
    ['GOOGLEDRIVE_CREATE_PERMISSION', ['createHint'], 'destructive'],
    ['OUTLOOK_CREATE_EMAIL_RULE', ['createHint'], 'destructive'],
    ['GITHUB_ADD_A_REPOSITORY_COLLABORATOR', ['createHint'], 'destructive'],
    ['GOOGLEDRIVE_WATCH_FILE', ['createHint'], 'destructive'],
    // Every word of the name pattern, inside an audited app where only the
    // pattern stops it (none of these is on the exact list).
    ['GOOGLECALENDAR_CREATE_ACL_ENTRY', ['createHint'], 'destructive'], // _ACL_
    ['GMAIL_SET_FORWARDING_ADDRESS', ['createHint'], 'destructive'], // FORWARD
    ['GMAIL_CREATE_SEND_AS_ALIAS', ['createHint'], 'destructive'], // SEND_AS
    ['GMAIL_SET_IMAP_ACCESS', ['createHint'], 'destructive'], // _IMAP_
    ['GMAIL_SET_POP_ACCESS', ['createHint'], 'destructive'], // _POP_
    ['GMAIL_ADD_FILTER_ENTRY', ['createHint'], 'destructive'], // FILTER
    ['GMAIL_SET_VACATION_RESPONDER', ['createHint'], 'destructive'], // VACATION
    ['GMAIL_ENABLE_AUTO_REPLIES', ['createHint'], 'destructive'], // AUTO_REPL
    ['GMAIL_START_WATCH_INBOX', ['createHint'], 'destructive'], // WATCH
    ['GOOGLECALENDAR_ADD_PERMISSION', ['createHint'], 'destructive'], // PERMISSION
    ['GOOGLECALENDAR_UPDATE_SHARING', ['createHint'], 'destructive'], // SHARING
    ['GOOGLECALENDAR_SHARE_CALENDAR', ['createHint'], 'destructive'], // SHARE_
    ['GMAIL_ADD_COLLABORATOR', ['createHint'], 'destructive'], // COLLABORAT
    ['GMAIL_CREATE_GROUP_MEMBERSHIP', ['createHint'], 'destructive'], // MEMBERSHIP
    ['GOOGLECALENDAR_SEND_INVITATION', ['createHint'], 'destructive'], // INVITAT
    ['GMAIL_CREATE_INBOX_RULE', ['createHint'], 'destructive'], // _RULE
    ['GOOGLECALENDAR_CREATE_WEBHOOK', ['createHint'], 'destructive'], // WEBHOOK
    ['GMAIL_ADD_HOOK', ['createHint'], 'destructive'], // _HOOK
    ['GOOGLECALENDAR_CREATE_SUBSCRIPTION', ['createHint'], 'destructive'], // SUBSCRI
    ['GMAIL_ADD_DEPLOY_KEY', ['createHint'], 'destructive'], // DEPLOY_KEY
    ['GMAIL_SET_CLIENT_SECRET', ['createHint'], 'destructive'], // SECRET
    ['GOOGLECALENDAR_TRANSFER_OWNERSHIP', ['createHint'], 'destructive'], // TRANSFER
    ['GMAIL_ADD_DELEGATE', ['createHint'], 'destructive'], // DELEGAT
    ['GOOGLECALENDAR_SET_VISIBILITY', ['createHint'], 'destructive'], // VISIBILITY
    ['GMAIL_UPDATE_MAILBOX_SETTINGS', ['createHint'], 'destructive'], // MAILBOX_SETTINGS
    ['OUTLOOK_SET_AUTO_FORWARDING', ['updateHint'], 'destructive'],
    ['GOOGLEDRIVE_CREATE_ACL_ENTRY', ['createHint'], 'destructive'],
    ['SLACK_CHANNELS_WATCH', ['createHint', 'openWorldHint'], 'destructive'],
    ['OUTLOOK_SET_AUTO_REPLY', ['updateHint'], 'destructive'],
    // Removes, cancels, revokes, or changes irreversibly: never in a level.
    ['GMAIL_DELETE_MESSAGE', ['destructiveHint'], 'destructive'],
    [
      'GMAIL_BATCH_DELETE_MESSAGES',
      ['important', 'destructiveHint', 'idempotentHint'],
      'destructive',
    ],
    [
      'GMAIL_SEND_DRAFT',
      ['important', 'openWorldHint', 'destructiveHint', 'updateHint'],
      'destructive',
    ],
    ['GMAIL_CONFLICT', ['createHint', 'destructiveHint'], 'destructive'],
    // No verdict, or a tag DorkOS does not know: the strictest tier.
    ['GMAIL_UNKNOWN', [], 'destructive'],
    ['GMAIL_UNKNOWN', ['futureEffectHint'], 'destructive'],
    ['GMAIL_UNKNOWN', ['openWorldHint', 'idempotentHint'], 'destructive'],
    ['GMAIL_UNKNOWN', ['createHint', 'futureEffectHint'], 'destructive'],
    ['GMAIL_UNKNOWN', ['important', 'gmail', 'messages'], 'destructive'],
    // Contradictory verdicts.
    ['GMAIL_CONFLICT', ['readOnlyHint', 'createHint'], 'destructive'],
    ['GMAIL_CONFLICT', ['updateHint', 'readOnlyHint'], 'destructive'],
    ['GMAIL_CONFLICT', ['readOnlyHint', 'futureEffectHint'], 'destructive'],
    ['GMAIL_CONFLICT', ['destructiveHint', 'readOnlyHint'], 'destructive'],
    // Explicit, uncontradicted read.
    ['GMAIL_GET_PROFILE', ['readOnlyHint'], 'read'],
    ['GMAIL_GET_PROFILE', ['important', 'openWorldHint', 'idempotentHint', 'readOnlyHint'], 'read'],
    // Category tags ride in the same list and are not verdicts: ignored.
    [
      'GMAIL_LIST_MESSAGES',
      ['important', 'readOnlyHint', 'openWorldHint', 'messages', 'deprecated'],
      'read',
    ],
    [
      'GOOGLECALENDAR_CREATE_EVENT',
      ['openWorldHint', 'important', 'Events Management', 'createHint'],
      'write',
    ],
    [
      'GMAIL_BATCH_DELETE_MESSAGES',
      ['gmail', 'destructiveHint', 'batch', 'messages'],
      'destructive',
    ],
  ])('retains %s with conservative effects for %j', async (slug, tags, classification) => {
    // Each action is listed under its own app, as Composio names it: GMAIL_… is gmail.
    const toolkit = slug.split('_')[0]!.toLowerCase();
    const metadata = {
      ...tool(slug, tags),
      toolkit: { slug: toolkit, name: toolkit, logo: 'https://fixture.invalid/app.svg' },
    };
    const local = await fixture((_request, response) =>
      json(response, 200, {
        current_page: 1,
        total_pages: 1,
        total_items: 1,
        next_cursor: null,
        items: [metadata],
      })
    );
    const result = await client(local.baseUrl).listOperationSchemas(INSTANCE_ID, {
      toolkit,
      toolkitVersion: TOOLKIT_VERSION,
      limit: 10,
      signal: new AbortController().signal,
    });
    expect(result.page.operations).toHaveLength(1);
    expect(result.page.operations[0]).toMatchObject({
      operationSlug: slug,
      toolkit,
      toolkitVersion: TOOLKIT_VERSION,
      capabilityClassification: classification,
      retryPolicy: 'never',
      inputSchema: metadata.input_parameters,
      schemaHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(local.requests.map(({ method }) => method)).toEqual(['GET']);
  });

  it('classifies Composio’s live Gmail and Calendar tags: deletes never in a level', async () => {
    // Slugs and tags exactly as Composio listed them (latest versions, 2026-09-28).
    const live = JSON.parse(
      readFileSync(new URL('./fixtures/live-tool-tags.json', import.meta.url), 'utf8')
    ) as Record<string, Array<{ slug: string; tags: string[] }>>;
    const classOf = new Map<string, string>();
    for (const [toolkit, actions] of Object.entries(live)) {
      const items = actions.map(({ slug, tags }) => ({
        ...tool(slug, tags),
        toolkit: { slug: toolkit, name: toolkit, logo: 'https://fixture.invalid/app.svg' },
      }));
      const local = await fixture((_request, response) =>
        json(response, 200, {
          current_page: 1,
          total_pages: 1,
          total_items: items.length,
          next_cursor: null,
          items,
        })
      );
      const result = await client(local.baseUrl).listOperationSchemas(INSTANCE_ID, {
        toolkit,
        toolkitVersion: TOOLKIT_VERSION,
        limit: 1_000,
        signal: new AbortController().signal,
      });
      for (const operation of result.page.operations)
        classOf.set(operation.operationSlug, operation.capabilityClassification);
    }
    expect(classOf.size).toBe(Object.values(live).flat().length);

    const removing = [...classOf.keys()].filter((slug) => /DELETE|REMOVE|CLEAR/.test(slug));
    expect(removing.length).toBeGreaterThan(0);
    for (const slug of removing) expect([slug, classOf.get(slug)]).toEqual([slug, 'destructive']);
    for (const slug of [
      'GMAIL_SEND_EMAIL',
      'GMAIL_REPLY_TO_THREAD',
      'GMAIL_CREATE_EMAIL_DRAFT',
      'GMAIL_ADD_LABEL_TO_EMAIL',
      'GMAIL_MOVE_TO_TRASH',
      'GOOGLECALENDAR_CREATE_EVENT',
      'GOOGLECALENDAR_UPDATE_EVENT',
      'GOOGLECALENDAR_QUICK_ADD',
    ])
      expect([slug, classOf.get(slug)]).toEqual([slug, 'write']);
    // Composio calls these create/update, but they share access, redirect
    // mail, change the sending identity or delivery, or start a subscription:
    // DorkOS keeps them out of every level.
    const accountReach = [
      'GOOGLECALENDAR_ACL_INSERT',
      'GOOGLECALENDAR_ACL_PATCH',
      'GOOGLECALENDAR_ACL_UPDATE',
      'GOOGLECALENDAR_ACL_WATCH',
      'GOOGLECALENDAR_CALENDAR_LIST_WATCH',
      'GOOGLECALENDAR_EVENTS_WATCH',
      'GOOGLECALENDAR_SETTINGS_WATCH',
      'GMAIL_CREATE_FILTER',
      'GMAIL_FORWARD_MESSAGE',
      'GMAIL_PATCH_SEND_AS',
      'GMAIL_UPDATE_SEND_AS',
      'GMAIL_UPDATE_IMAP_SETTINGS',
      'GMAIL_UPDATE_POP_SETTINGS',
      'GMAIL_IMPORT_MESSAGE',
      'GMAIL_INSERT_MESSAGE',
      'GMAIL_UPDATE_VACATION_SETTINGS',
      'GMAIL_BATCH_MODIFY_MESSAGES',
      'GOOGLECALENDAR_EVENTS_MOVE',
    ];
    for (const slug of accountReach)
      expect([slug, classOf.get(slug)]).toEqual([slug, 'destructive']);
    // The tightening only ever moves write to destructive: reads it names stay reads.
    expect(classOf.get('GOOGLECALENDAR_ACL_LIST')).toBe('read');
    expect(classOf.get('GMAIL_LIST_FILTERS')).toBe('read');
    for (const slug of [
      'GMAIL_LIST_MESSAGES',
      'GMAIL_GET_DRAFT',
      'GOOGLECALENDAR_EVENTS_LIST',
      'GOOGLECALENDAR_FIND_FREE_SLOTS',
    ])
      expect([slug, classOf.get(slug)]).toEqual([slug, 'read']);
    expect(classOf.get('GMAIL_SEND_DRAFT')).toBe('destructive');
    // The whole of "Read and write" for these two apps, pinned so any change is reviewed.
    expect(
      [...classOf]
        .filter(([, classification]) => classification === 'write')
        .map(([slug]) => slug)
        .sort()
    ).toEqual([
      'GMAIL_ADD_LABEL_TO_EMAIL',
      'GMAIL_CREATE_EMAIL_DRAFT',
      'GMAIL_CREATE_LABEL',
      'GMAIL_MODIFY_THREAD_LABELS',
      'GMAIL_MOVE_THREAD_TO_TRASH',
      'GMAIL_MOVE_TO_TRASH',
      'GMAIL_PATCH_LABEL',
      'GMAIL_REPLY_TO_THREAD',
      'GMAIL_SEND_EMAIL',
      'GMAIL_UNTRASH_MESSAGE',
      'GMAIL_UNTRASH_THREAD',
      'GMAIL_UPDATE_DRAFT',
      'GMAIL_UPDATE_LABEL',
      'GMAIL_UPDATE_LANGUAGE_SETTINGS',
      'GOOGLECALENDAR_CALENDARS_UPDATE',
      'GOOGLECALENDAR_CALENDAR_LIST_INSERT',
      'GOOGLECALENDAR_CALENDAR_LIST_PATCH',
      'GOOGLECALENDAR_CALENDAR_LIST_UPDATE',
      'GOOGLECALENDAR_CREATE_CALENDAR',
      'GOOGLECALENDAR_CREATE_EVENT',
      'GOOGLECALENDAR_DUPLICATE_CALENDAR',
      'GOOGLECALENDAR_EVENTS_IMPORT',
      'GOOGLECALENDAR_PATCH_CALENDAR',
      'GOOGLECALENDAR_PATCH_EVENT',
      'GOOGLECALENDAR_QUICK_ADD',
      'GOOGLECALENDAR_UPDATE_EVENT',
    ]);
  });

  it('classifies identically on this computer and in the hosted DorkOS account path', async () => {
    const gmail = { slug: 'gmail', name: 'Gmail', logo: 'https://fixture.invalid/gmail.svg' };
    const items = [
      { ...tool('GMAIL_FETCH_EMAILS', ['readOnlyHint']), toolkit: gmail },
      { ...tool('GMAIL_SEND_EMAIL', ['important', 'openWorldHint', 'createHint']), toolkit: gmail },
      { ...tool('GMAIL_FORWARD_MESSAGE', ['createHint']), toolkit: gmail },
      { ...tool('GMAIL_DELETE_MESSAGE', ['destructiveHint']), toolkit: gmail },
      { ...tool('GMAIL_FUTURE', ['createHint', 'futureEffectHint']), toolkit: gmail },
    ];
    const local = await fixture((_request, response) =>
      json(response, 200, {
        current_page: 1,
        total_pages: 1,
        total_items: items.length,
        next_cursor: null,
        items,
      })
    );
    const hosted = createComposioHostedClients({
      apiKey: API_KEY,
      serverUserId: SERVER_USER_ID,
      authConfigByToolkit: {},
      baseUrl: local.baseUrl,
    }).operations;
    const classes = async (operations: ComposioSdkClient) => {
      const result = await operations.listOperationSchemas(INSTANCE_ID, {
        toolkit: 'gmail',
        toolkitVersion: TOOLKIT_VERSION,
        limit: 10,
        signal: new AbortController().signal,
      });
      return result.page.operations.map((operation) => [
        operation.operationSlug,
        operation.capabilityClassification,
      ]);
    };
    const expected = [
      ['GMAIL_FETCH_EMAILS', 'read'],
      ['GMAIL_SEND_EMAIL', 'write'],
      ['GMAIL_FORWARD_MESSAGE', 'destructive'],
      ['GMAIL_DELETE_MESSAGE', 'destructive'],
      ['GMAIL_FUTURE', 'destructive'],
    ];
    expect(await classes(client(local.baseUrl))).toEqual(expected);
    expect(await classes(hosted)).toEqual(expected);
  });

  it('carries the display name and the important tag as hints, without changing the classification', async () => {
    const local = await fixture((_request, response) =>
      json(response, 200, {
        current_page: 1,
        total_pages: 1,
        total_items: 2,
        next_cursor: null,
        items: [
          { ...tool('GITHUB_SEND', ['important', 'openWorldHint']), name: '  Send Thing ' },
          { ...tool('GITHUB_GET', ['readOnlyHint']), name: '' },
        ],
      })
    );
    const result = await client(local.baseUrl).listOperationSchemas(INSTANCE_ID, {
      toolkit: 'github',
      toolkitVersion: TOOLKIT_VERSION,
      limit: 10,
      signal: new AbortController().signal,
    });
    expect(result.page.operations[0]).toMatchObject({
      displayName: 'Send Thing',
      important: true,
      capabilityClassification: 'destructive',
    });
    expect(result.page.operations[1]).toMatchObject({
      important: false,
      capabilityClassification: 'read',
    });
    expect(result.page.operations[1]).not.toHaveProperty('displayName');
  });

  it.each(['toolkit', 'version'])(
    'rejects uncertain metadata with mismatched %s',
    async (field) => {
      const metadata = tool('GITHUB_UNKNOWN', []);
      if (field === 'toolkit') metadata.toolkit.slug = 'gmail';
      else metadata.version = '20200101_00';
      const local = await fixture((_request, response) =>
        json(response, 200, {
          current_page: 1,
          total_pages: 1,
          total_items: 1,
          next_cursor: null,
          items: [metadata],
        })
      );
      await expect(
        client(local.baseUrl).listOperationSchemas(INSTANCE_ID, {
          toolkit: 'github',
          toolkitVersion: TOOLKIT_VERSION,
          limit: 10,
          signal: new AbortController().signal,
        })
      ).rejects.toThrow('another version');
      expect(local.requests.map(({ method }) => method)).toEqual(['GET']);
    }
  );

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
    // The wrapper keeps what it wrapped, so a log can name the cause's class,
    // while its own message stays fixed.
    expect((failure as Error).message).toBe(
      'Composio catalog discovery failed. Check the provider status.'
    );
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect((failure as Error).cause).not.toBe(failure);
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agents,
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import type { ConnectorAppConnections } from '@dorkos/shared/connector-resource-schemas';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { ManagedConnectorCatalogRequestSchema } from '@dorkos/shared/connector-managed-discovery-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { requestManagedConnectorCatalog } from '../../core/auth/cloud-link-client.js';
import {
  ManagedCloudConnectorProvider,
  type ManagedConnectorCloudPort,
} from '../providers/managed/managed-cloud.js';
import {
  ConnectorOperatorQueryError,
  ConnectorOperatorQueryService,
} from '../resources/operator-query-service.js';
import type { NangoHttpClient, NangoIntegration } from '../providers/nango-client.js';
import { NangoConnectorProvider } from '../providers/nango.js';
import { ConnectionStore } from '../connection-store.js';
import { ConnectorRegistry } from '../registry.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const FOREIGN_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;
const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');
const NOW = '2026-09-06T18:00:00.000Z';

describe('ConnectorOperatorQueryService', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let service: ConnectorOperatorQueryService;
  let provider: FakeConnectorProvider;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    provider = new FakeConnectorProvider({
      instanceId: PROVIDER_ID,
      type: 'fake',
      custody: 'managed',
      toolkits: [
        {
          slug: 'gmail',
          displayName: 'Gmail',
          authKind: 'oauth2',
          authentication: { status: 'available' },
        },
        {
          slug: 'linear',
          displayName: 'Linear',
          authKind: 'api-key',
          authentication: {
            status: 'unsupported',
            reason: 'Managed account sign-in is not available for this service yet.',
          },
        },
      ],
    });
    registry.register(provider, 'material-a');
    db.insert(agents)
      .values({
        id: 'agent-a',
        name: 'agent-a',
        displayName: 'Researcher',
        runtime: 'claude-code',
        projectPath: '/agents/agent-a',
        registeredAt: NOW,
        updatedAt: NOW,
      })
      .run();
    db.insert(connections)
      .values({
        id: 'connection-a',
        providerInstanceId: PROVIDER_ID,
        externalAccountRef: 'private-account-a',
        toolkit: 'gmail',
        label: 'Work Gmail',
        identityHint: 'work@example.com',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-a',
        providerInstanceId: PROVIDER_ID,
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.list',
        toolkitVersion: '20260901',
        schemaHash: 'sha256:a',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', properties: {} }),
        discoveredAt: NOW,
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-a',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: NOW,
      })
      .run();
    service = new ConnectorOperatorQueryService({
      db,
      registry,
      relay: { getManifest: (type) => (type === 'gmail' ? { displayName: 'Gmail' } : undefined) },
      sessions: {
        resolveSessionAgent: (_owner, sessionId) =>
          sessionId === 'session-a' ? { agentId: 'agent-a' } : undefined,
      },
      agentOwnership: {
        ownsAgent: (owner, agentId) =>
          owner.kind === 'local_install' &&
          owner.installationId === OWNER.installationId &&
          agentId === 'agent-a',
      },
    });
  });

  it('omits removed account cards and refuses their owner detail without deleting history', async () => {
    db.update(connections)
      .set({ lifecycleState: 'disconnected', removedAt: NOW })
      .where(eq(connections.id, 'connection-a'))
      .run();
    expect(await service.listConnections(OWNER)).toEqual([]);
    await expect(service.getConnection(OWNER, 'connection-a')).rejects.toThrow(
      'Connection not found'
    );
    expect(db.select().from(connections).all()).toHaveLength(1);
    expect(db.select().from(connectionOperationGrants).all()).toHaveLength(1);
  });

  it('marks a kept account whose way is down, so the card asks for that fix, not a new sign-in', async () => {
    const wayProblem = vi.fn((providerInstanceId: string) =>
      providerInstanceId === PROVIDER_ID ? ('dorkos_account_unlinked' as const) : undefined
    );
    const withWays = new ConnectorOperatorQueryService({
      db,
      registry,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
      wayProblem,
    });

    const [kept] = await withWays.listConnections(OWNER);
    expect(kept).toMatchObject({
      connectionId: 'connection-a',
      wayProblem: 'dorkos_account_unlinked',
    });
    expect(wayProblem).toHaveBeenCalledWith(PROVIDER_ID);

    // A disconnected account needs its own sign-in whatever its way's state.
    db.update(connections)
      .set({ lifecycleState: 'disconnected' })
      .where(eq(connections.id, 'connection-a'))
      .run();
    const [disconnected] = await withWays.listConnections(OWNER);
    expect(disconnected).not.toHaveProperty('wayProblem');

    // Nothing is marked while the way works.
    const [working] = await service.listConnections(OWNER);
    expect(working).not.toHaveProperty('wayProblem');
  });

  it('returns one account-free catalog with per-route authentication and message intents', async () => {
    const catalog = await service.catalog({ signal: new AbortController().signal });

    // The live Gmail route merges into the built-in Gmail row: one row, not two.
    expect(catalog.services.filter((entry) => entry.serviceSlug === 'gmail')).toHaveLength(1);
    expect(catalog.services.find((entry) => entry.serviceSlug === 'gmail')).toEqual(
      expect.objectContaining({
        popular: true,
        description: 'Read, search and send email.',
        signInName: 'Google',
        intents: [
          expect.objectContaining({ kind: 'messages' }),
          expect.objectContaining({
            kind: 'account',
            routes: [
              expect.objectContaining({ authKind: 'oauth2', providerInstanceId: PROVIDER_ID }),
            ],
          }),
        ],
      })
    );
    expect(catalog.services.find((entry) => entry.serviceSlug === 'linear')).toEqual(
      expect.objectContaining({
        intents: [
          expect.objectContaining({
            kind: 'account',
            routes: [
              expect.objectContaining({
                authKind: 'api-key',
                capabilities: expect.objectContaining({
                  authentication: {
                    status: 'unsupported',
                    reason: 'Managed account sign-in is not available for this service yet.',
                  },
                }),
              }),
            ],
          }),
        ],
      })
    );
    expect(JSON.stringify(catalog)).not.toContain('private-account-a');
  });

  it('always lists the popular apps, each needing a way set up before it can connect', async () => {
    const empty = new ConnectorOperatorQueryService({
      db,
      registry: new ConnectorRegistry({
        db,
        configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
      }),
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
      appConnections: async () => ({
        ways: [],
        newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
      }),
    });

    const gmail = await empty.catalog({ query: 'gmail', signal: new AbortController().signal });
    expect(gmail).toEqual({
      services: [
        {
          serviceSlug: 'gmail',
          displayName: 'Gmail',
          iconKey: 'gmail',
          description: 'Read, search and send email.',
          category: 'email',
          popular: true,
          signInName: 'Google',
          intents: [{ kind: 'account', displayName: 'Use a Gmail account', routes: [] }],
        },
      ],
      warnings: [],
      appConnections: { ways: [], newApps: { status: 'setup_needed', reason: 'nothing_set_up' } },
    });

    // A search for what an app does finds it by its one line.
    const pages = await empty.catalog({ query: 'pages and', signal: new AbortController().signal });
    expect(pages.services.map((entry) => entry.serviceSlug)).toEqual(['notion']);

    // A search by shelf finds the apps on it.
    const email = await empty.catalog({ query: 'email', signal: new AbortController().signal });
    expect(email.services.map((entry) => entry.serviceSlug)).toEqual(['gmail', 'outlook']);
    const outlook = email.services[1]?.intents[0];
    expect(outlook?.displayName).toBe('Use an Outlook account');

    // Chat apps are listed with nothing set up, and never as an account to sign in to.
    const all = await empty.catalog({ limit: 100, signal: new AbortController().signal });
    const telegram = all.services.find((entry) => entry.serviceSlug === 'telegram');
    expect(telegram?.intents).toEqual([
      {
        kind: 'messages',
        displayName: 'Messages through a Telegram bot',
        relayAdapterType: 'telegram',
      },
    ]);
    expect(all.services.find((entry) => entry.serviceSlug === 'webhook')?.category).toBe(
      'developer'
    );

    // An agent can still ask for an app no way reaches yet (DOR-2494): the
    // request's card runs the one-time step first. The reason travels with it.
    const directory = await empty.serviceDirectory(new AbortController().signal);
    expect(directory.services).toContainEqual({
      serviceSlug: 'gmail',
      displayName: 'Gmail',
      requestable: true,
      reached: false,
    });
    expect(directory.reachProblem).toBe('nothing_set_up');
    // A chat app still has no account to ask for.
    expect(directory.services).toContainEqual({
      serviceSlug: 'telegram',
      displayName: 'Telegram',
      requestable: false,
      unavailableBecause: 'messaging_only',
    });
  });

  it('says why no way reaches an app: which way is down, or that the working one misses it', async () => {
    const registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    const signal = new AbortController().signal;
    const directoryFor = (appConnections: ConnectorAppConnections) =>
      new ConnectorOperatorQueryService({
        db,
        registry,
        sessions: { resolveSessionAgent: () => undefined },
        agentOwnership: { ownsAgent: () => false },
        appConnections: async () => appConnections,
      }).serviceDirectory(signal);

    const unlinked = await directoryFor({
      ways: [{ kind: 'dorkos_account', type: 'dorkos-managed', status: 'unlinked' }],
      newApps: { status: 'setup_needed', reason: 'dorkos_account_unlinked' },
    });
    expect(unlinked.reachProblem).toBe('dorkos_account_unlinked');

    const nango = {
      kind: 'own_key' as const,
      type: 'nango',
      status: 'ready' as const,
      providerInstanceId: ConnectorProviderInstanceIdSchema.parse('provider-nango'),
    };
    const misses = await directoryFor({ ways: [nango], newApps: { status: 'ready', way: nango } });
    expect(misses.reachProblem).toBe('app_not_reached');
  });

  it('gives each app a same-origin logo path and one line, never the service’s logo URL', async () => {
    const logoRegistry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    logoRegistry.register(
      new FakeConnectorProvider({
        instanceId: ConnectorProviderInstanceIdSchema.parse('provider-logos'),
        type: 'fake',
        custody: 'managed',
        toolkits: [
          {
            slug: 'gmail',
            displayName: 'Gmail',
            authKind: 'oauth2',
            logoUrl: 'https://logos.composio.dev/api/gmail',
            description: 'Gmail is Google’s email service.',
          },
          {
            slug: 'zendesk',
            displayName: 'Zendesk',
            authKind: 'oauth2',
            logoUrl: 'https://logos.composio.dev/api/zendesk',
            description: 'Zendesk runs customer support tickets.',
          },
          // Only another app's kept logo can give this one a mark.
          { slug: 'freshdesk', displayName: 'Freshdesk', authKind: 'oauth2' },
          { slug: 'bare', displayName: 'Bare', authKind: 'oauth2' },
          // Not a safe path segment, so it can never get a logo path.
          {
            slug: 'Odd.Slug',
            displayName: 'Odd',
            authKind: 'oauth2',
            logoUrl: 'https://logos.composio.dev/api/odd',
          },
        ],
      }),
      'material-logos'
    );
    const logos = new ConnectorOperatorQueryService({
      db,
      registry: logoRegistry,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
      keptLogos: () => Promise.resolve(new Set(['freshdesk'])),
    });
    const signal = new AbortController().signal;

    const page = await logos.catalog({ limit: 100, signal });
    const bySlug = new Map(page.services.map((entry) => [entry.serviceSlug, entry]));

    // Our own line wins for a built-in app; the logo is the server's own path.
    expect(bySlug.get('gmail')).toMatchObject({
      description: 'Read, search and send email.',
      logo: '/api/connectors/catalog/logos/gmail',
    });
    expect(bySlug.get('zendesk')).toMatchObject({
      description: 'Zendesk runs customer support tickets.',
      logo: '/api/connectors/catalog/logos/zendesk',
    });
    expect(bySlug.get('freshdesk')?.logo).toBe('/api/connectors/catalog/logos/freshdesk');
    expect(bySlug.get('bare')).not.toHaveProperty('logo');
    expect(bySlug.get('bare')).not.toHaveProperty('description');
    expect(bySlug.get('Odd.Slug')).not.toHaveProperty('logo');
    // A built-in app nothing sends a logo for has none either.
    expect(bySlug.get('notion')).not.toHaveProperty('logo');
    expect(JSON.stringify(page)).not.toContain('logos.composio.dev');
  });

  it('lists a popular app a self-hosted Nango server reaches once, under the app (DOR-2436)', async () => {
    const integrations: NangoIntegration[] = [
      {
        uniqueKey: 'google-mail',
        provider: 'google-mail',
        displayName: 'Gmail',
        authMode: 'OAUTH2',
        logoUrl: 'https://app.nango.dev/images/template-logos/google-mail.svg',
      },
      { uniqueKey: 'mail-work', provider: 'google-mail', displayName: 'Gmail' },
      { uniqueKey: 'acme-crm', provider: 'acme', displayName: 'Acme' },
    ];
    const client: NangoHttpClient = {
      listIntegrations: () => Promise.resolve(integrations),
      initiateConnection: () => Promise.reject(new Error('not used')),
      getConnectionState: () => Promise.reject(new Error('not used')),
      listConnections: () => Promise.resolve([]),
      deleteConnection: () => Promise.resolve(),
    };
    const nangoRegistry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    nangoRegistry.register(
      new NangoConnectorProvider({
        client,
        instanceId: ConnectorProviderInstanceIdSchema.parse('provider-nango'),
      }),
      'material-nango'
    );
    const queries = new ConnectorOperatorQueryService({
      db,
      registry: nangoRegistry,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
    });
    const signal = new AbortController().signal;

    const page = await queries.catalog({ limit: 100, signal });
    const slugs = page.services.map((entry) => entry.serviceSlug);
    expect(slugs).not.toContain('google-mail');
    expect(slugs.filter((slug) => slug === 'gmail')).toHaveLength(1);
    const gmail = page.services.find((entry) => entry.serviceSlug === 'gmail');
    expect(gmail).toMatchObject({
      displayName: 'Gmail',
      description: 'Read, search and send email.',
      logo: '/api/connectors/catalog/logos/gmail',
      popular: true,
      intents: [
        {
          kind: 'account',
          routes: [
            expect.objectContaining({ providerInstanceId: 'provider-nango', custody: 'self-host' }),
          ],
        },
      ],
    });
    // A second Gmail setup stays reachable on its own row, named so it never
    // reads as a copy of the popular one; an app DorkOS doesn't know keeps its key.
    expect(page.services.find((entry) => entry.serviceSlug === 'mail-work')?.displayName).toBe(
      'Gmail (mail-work)'
    );
    expect(slugs).toContain('acme-crm');

    // Gmail is now reached, and the Nango key is not a service it can name.
    const directory = await queries.serviceDirectory(signal);
    expect(directory.services).toContainEqual({
      serviceSlug: 'gmail',
      displayName: 'Gmail',
      requestable: true,
      reached: true,
    });
    expect(directory.services.map((entry) => entry.serviceSlug)).not.toContain('google-mail');
  });

  it('names the service an app will ask about on every route that signs in through one', async () => {
    const composio = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-composio'),
      type: 'composio',
      toolkits: [{ slug: 'notion', displayName: 'Notion', authKind: 'oauth2' }],
    });
    const composioRegistry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    composioRegistry.register(composio, 'material-composio');
    const queries = new ConnectorOperatorQueryService({
      db,
      registry: composioRegistry,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
    });

    const page = await queries.catalog({ query: 'notion', signal: new AbortController().signal });
    expect(page.services).toHaveLength(1);
    expect(page.services[0]?.intents).toEqual([
      expect.objectContaining({
        kind: 'account',
        routes: [expect.objectContaining({ signInThrough: 'Composio' })],
      }),
    ]);
    // A route type that names no service (the test double here) carries no line.
    const direct = await service.catalog({ query: 'gmail', signal: new AbortController().signal });
    const account = direct.services[0]?.intents.find((intent) => intent.kind === 'account');
    expect(account?.kind === 'account' && account.routes[0]).not.toHaveProperty('signInThrough');
  });

  it('refuses before managed recovery when canonical connector data is unavailable', async () => {
    const recoverManagedProvider = vi.fn<() => Promise<void>>().mockResolvedValue();
    const unavailableRegistry = new ConnectorRegistry({
      db,
      connectionStore: new ConnectionStore({
        db,
        runMigration: () => ({
          status: 'migration_failed',
          error: 'Connector data could not be upgraded.',
        }),
      }),
    });
    const unavailable = new ConnectorOperatorQueryService({
      db,
      registry: unavailableRegistry,
      recoverManagedProvider,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
    });

    await expect(
      unavailable.catalog({ signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: 'migration_failed' });
    expect(recoverManagedProvider).not.toHaveBeenCalled();
  });

  it('paginates the real managed wire within its strict page limit', async () => {
    const requests: Array<{ cursor?: string; limit: number; query?: string }> = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const request = ManagedConnectorCatalogRequestSchema.parse({
        version: Number(url.searchParams.get('version')),
        query: url.searchParams.get('query') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined,
        limit: Number(url.searchParams.get('limit')),
      });
      requests.push(request);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer synthetic-token');
      expect(headers.get('x-dorkos-catalog-auth-setup')).toBe('1');

      const toolkits = request.cursor
        ? [{ slug: 'mail-000', displayName: 'Mail 000', authKind: 'oauth2' as const }]
        : Array.from({ length: 100 }, (_, index) => ({
            slug: `mail-${index + 100}`,
            displayName: `Mail ${index + 100}`,
            authKind: 'oauth2' as const,
          }));
      return new Response(
        JSON.stringify({
          version: 1,
          toolkits,
          ...(request.cursor ? {} : { nextCursor: 'page-2' }),
          truncated: request.cursor === undefined,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const listManagedConnectorCatalog: ManagedConnectorCloudPort['listManagedConnectorCatalog'] = (
      request,
      signal
    ) =>
      requestManagedConnectorCatalog({
        baseUrl: 'https://managed.example',
        accessToken: 'synthetic-token',
        request,
        fetchImpl,
        signal,
      });
    const cloud = { listManagedConnectorCatalog } as unknown as ManagedConnectorCloudPort;
    registry.register(
      new ManagedCloudConnectorProvider({
        instanceId: ConnectorProviderInstanceIdSchema.parse('managed-cloud'),
        cloud,
        executionContext: () => undefined,
      }),
      'managed-material'
    );

    const catalog = await service.catalog({
      includeAuthenticationSetup: true,
      query: 'mail',
      limit: 100,
      signal: new AbortController().signal,
    });

    // The whole list is kept, so the search runs over it rather than upstream.
    expect(requests).toEqual([
      { version: 1, cursor: undefined, limit: 100 },
      { version: 1, cursor: 'page-2', limit: 100 },
    ]);
    expect(catalog.warnings).toEqual([]);
    expect(catalog.services).toHaveLength(100);
    expect(catalog.services).toContainEqual(
      expect.objectContaining({ serviceSlug: 'mail-000', displayName: 'Mail 000' })
    );
  });

  it('answers every page, search and agent lookup from one upstream listing per service', async () => {
    const listToolkitPage = vi.spyOn(provider, 'listToolkitPage');
    const bulk = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-bulk'),
      type: 'bulk',
      toolkits: Array.from({ length: 850 }, (_, index) => ({
        slug: `bulk-${String(index).padStart(3, '0')}`,
        displayName: `Bulk ${index}`,
        authKind: 'oauth2' as const,
      })),
    });
    const bulkPages = vi.spyOn(bulk, 'listToolkitPage');
    registry.register(bulk, 'material-bulk');
    const listings = (spy: typeof bulkPages) =>
      spy.mock.calls.filter(([request]) => request.cursor === undefined).length;

    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 5; page += 1) {
      const result = await service.catalog({
        limit: 24,
        ...(cursor !== undefined && { cursor }),
        signal: new AbortController().signal,
      });
      for (const entry of result.services) seen.add(entry.serviceSlug);
      cursor = result.nextCursor;
    }
    const search = await service.catalog({
      query: 'bulk 84',
      signal: new AbortController().signal,
    });
    await service.catalog({ query: 'gmail', signal: new AbortController().signal });
    await service.catalog({
      query: 'bulk',
      includeAuthenticationSetup: true,
      signal: new AbortController().signal,
    });
    const directory = await service.serviceDirectory(new AbortController().signal);

    expect(seen.size).toBe(120);
    // Search now also matches the service id, and runs over the kept list.
    expect(search.services.map((entry) => entry.serviceSlug)).toEqual([
      'bulk-084',
      'bulk-840',
      'bulk-841',
      'bulk-842',
      'bulk-843',
      'bulk-844',
      'bulk-845',
      'bulk-846',
      'bulk-847',
      'bulk-848',
      'bulk-849',
    ]);
    expect(directory.services.some((entry) => entry.serviceSlug === 'bulk-849')).toBe(true);
    expect(listings(bulkPages)).toBe(1);
    expect(listings(listToolkitPage)).toBe(1);
    // 850 apps at 100 a page, once.
    expect(bulkPages).toHaveBeenCalledTimes(9);
  });

  it('lists a service again as soon as its key or setup changes', async () => {
    const listToolkitPage = vi.spyOn(provider, 'listToolkitPage');
    await service.catalog({ signal: new AbortController().signal });
    await service.catalog({ query: 'linear', signal: new AbortController().signal });
    expect(listToolkitPage).toHaveBeenCalledTimes(1);

    // A key save reloads the provider: unregister, then register what answered.
    registry.unregisterProviderInstance(PROVIDER_ID);
    const rekeyed = new FakeConnectorProvider({
      instanceId: PROVIDER_ID,
      type: 'fake',
      toolkits: [{ slug: 'notion', displayName: 'Notion', authKind: 'oauth2' }],
    });
    registry.register(rekeyed, 'material-b');
    const page = await service.catalog({ query: 'notion', signal: new AbortController().signal });

    expect(page.services.find((entry) => entry.serviceSlug === 'notion')?.intents).toContainEqual(
      expect.objectContaining({ kind: 'account', routes: [expect.anything()] })
    );
    const gmail = await service.catalog({ query: 'gmail', signal: new AbortController().signal });
    // Gmail is a popular app, so it stays listed — but no longer reachable.
    expect(gmail.services[0]?.intents).toContainEqual(
      expect.objectContaining({ kind: 'account', routes: [] })
    );
  });

  it('projects negotiated setup without leaking it to released catalog clients', async () => {
    vi.spyOn(provider, 'listToolkitPage').mockResolvedValue({
      status: 'ok',
      truncated: false,
      toolkits: [
        {
          slug: 'synthetic',
          displayName: 'Synthetic',
          authKind: 'oauth2',
          authentication: { status: 'available' },
          authenticationSetup: {
            kind: 'fields',
            source: 'account-fields',
            scheme: 'BEARER_TOKEN',
            requiresAccountFields: true,
          },
        },
      ],
    });
    const synthetic = (page: { services: Array<{ serviceSlug: string; intents: unknown }> }) =>
      page.services.find((entry) => entry.serviceSlug === 'synthetic')?.intents;
    const legacy = await service.catalog({ signal: new AbortController().signal });
    expect(JSON.stringify(legacy)).not.toContain('authenticationSetup');
    expect(synthetic(legacy)).toEqual([
      expect.objectContaining({
        kind: 'account',
        routes: [
          expect.objectContaining({
            authKind: 'api-key',
            capabilities: expect.objectContaining({
              authentication: expect.objectContaining({ status: 'unsupported' }),
            }),
          }),
        ],
      }),
    ]);
    const rich = await service.catalog({
      includeAuthenticationSetup: true,
      signal: new AbortController().signal,
    });
    expect(synthetic(rich)).toEqual([
      expect.objectContaining({
        kind: 'account',
        routes: [
          expect.objectContaining({
            authenticationSetup: expect.objectContaining({ kind: 'fields' }),
            capabilities: expect.objectContaining({ authentication: { status: 'available' } }),
          }),
        ],
      }),
    ]);
  });

  it('never lets a toolkit override elevate unavailable provider authentication', async () => {
    const capabilities = provider.getCapabilities();
    vi.spyOn(provider, 'getCapabilities').mockReturnValue({
      ...capabilities,
      capabilities: {
        ...capabilities.capabilities,
        authentication: {
          status: 'unsupported',
          reason: 'Managed connections are awaiting production verification.',
        },
      },
    });

    const catalog = await service.catalog({ signal: new AbortController().signal });
    const gmail = catalog.services.find((service) => service.serviceSlug === 'gmail');
    expect(gmail).toBeDefined();
    expect(gmail?.intents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'account',
          routes: [
            expect.objectContaining({
              capabilities: expect.objectContaining({
                authentication: {
                  status: 'unsupported',
                  reason: 'Managed connections are awaiting production verification.',
                },
              }),
            }),
          ],
        }),
      ])
    );
  });

  it('lists native message services without any account provider and preserves filtering and paging', async () => {
    const nativeOnly = new ConnectorOperatorQueryService({
      db,
      registry: new ConnectorRegistry({
        db,
        configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
      }),
      relay: {
        getManifest: (type) =>
          type === 'slack' || type === 'telegram' || type === 'discord'
            ? { displayName: type }
            : undefined,
        getCatalog: () => [
          { manifest: { type: 'telegram', displayName: 'Telegram' } },
          { manifest: { type: 'slack', displayName: 'Slack' } },
          { manifest: { type: 'discord', displayName: 'Discord' } },
          // Plumbing and retired chat apps are never something a person connects.
          { manifest: { type: 'claude-code', displayName: 'Claude Code', category: 'internal' } },
          { manifest: { type: 'old-chat', displayName: 'Old Chat', deprecated: true } },
        ],
      },
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
    });

    await expect(
      nativeOnly.catalog({ query: 'disc', limit: 1, signal: new AbortController().signal })
    ).resolves.toEqual({
      services: [
        {
          serviceSlug: 'discord',
          displayName: 'Discord',
          iconKey: 'discord',
          intents: [
            {
              kind: 'messages',
              displayName: 'Messages through a Discord bot',
              relayAdapterType: 'discord',
            },
          ],
        },
      ],
      warnings: [],
    });

    // Popular apps lead, in name order; everything else follows them.
    const slugs: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await nativeOnly.catalog({
        limit: 7,
        ...(cursor && { cursor }),
        signal: new AbortController().signal,
      });
      slugs.push(...page.services.map((entry) => entry.serviceSlug));
      cursor = page.nextCursor;
    } while (cursor);
    expect(slugs).toHaveLength(19);
    expect(slugs.slice(0, 3)).toEqual(['gmail', 'outlook', 'googlecalendar']);
    expect(slugs.at(-1)).toBe('discord');
    expect(slugs).not.toContain('claude-code');
    expect(slugs).not.toContain('old-chat');
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('gives agent requests the catalog read itself: recovery first, every page, Messaging marked', async () => {
    const recoveredRegistry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    // More than one provider page, so an unpaged read would miss the last service.
    const recovered = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-recovered'),
      type: 'composio',
      toolkits: Array.from({ length: 150 }, (_, index) => ({
        slug: index === 149 ? 'gmail' : `service-${String(index).padStart(3, '0')}`,
        displayName: index === 149 ? 'Gmail' : `Service ${index}`,
        authKind: 'oauth2' as const,
      })),
    });
    const recoverManagedProvider = vi.fn(async () => {
      if (!recoveredRegistry.resolveProviderInstance(recovered.instanceId)) {
        recoveredRegistry.register(recovered, 'material-recovered');
      }
    });
    const queries = new ConnectorOperatorQueryService({
      db,
      registry: recoveredRegistry,
      recoverManagedProvider,
      relay: {
        getManifest: (type) => (type === 'telegram' ? { displayName: 'Telegram' } : undefined),
        getCatalog: () => [{ manifest: { type: 'telegram', displayName: 'Telegram' } }],
      },
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
    });

    const directory = await queries.serviceDirectory(new AbortController().signal);

    expect(recoverManagedProvider).toHaveBeenCalledOnce();
    // 150 live services plus the popular apps the live page did not already list.
    expect(directory.services).toHaveLength(167);
    expect(directory.services).toContainEqual({
      serviceSlug: 'gmail',
      displayName: 'Gmail',
      requestable: true,
      reached: true,
    });
    expect(directory.services).toContainEqual({
      serviceSlug: 'telegram',
      displayName: 'Telegram',
      requestable: false,
      unavailableBecause: 'messaging_only',
    });
    expect(directory.warnings).toEqual([]);
    // Types only: a person's label for a route never hides a service word.
    expect(directory.routeTypes).toEqual(['composio']);
  });

  it('retains native message services when an account provider catalog fails', async () => {
    const failing = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-failing'),
      type: 'failing',
    });
    Object.defineProperty(failing, 'listToolkitPage', {
      value: () => Promise.reject(new Error('provider unavailable')),
    });
    const failingRegistry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    failingRegistry.register(failing);
    const withFailure = new ConnectorOperatorQueryService({
      db,
      registry: failingRegistry,
      relay: {
        getManifest: (type) => (type === 'slack' ? { displayName: 'Slack' } : undefined),
        getCatalog: () => [{ manifest: { type: 'slack', displayName: 'Slack' } }],
      },
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
    });

    const page = await withFailure.catalog({ signal: new AbortController().signal });
    expect(page.warnings).toMatchObject([{ code: 'catalog_provider_unavailable' }]);
    expect(page.services.find((entry) => entry.serviceSlug === 'slack')).toMatchObject({
      intents: [{ kind: 'messages' }, { kind: 'account', routes: [] }],
    });
  });

  it('scopes connection detail and agent profiles to the verified owner', async () => {
    await expect(service.listConnections(OWNER)).resolves.toEqual([
      expect.objectContaining({
        connectionId: 'connection-a',
        agentCount: 1,
        usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
      }),
    ]);
    await expect(service.getConnection(OWNER, 'connection-a')).resolves.toMatchObject({
      agents: [{ agentId: 'agent-a', operationRevisionIds: ['revision-a'] }],
      provider: { providerInstanceId: PROVIDER_ID },
    });
    await expect(service.listConnections(FOREIGN_OWNER)).resolves.toEqual([]);
    await expect(service.getConnection(FOREIGN_OWNER, 'connection-a')).rejects.toThrow(
      ConnectorOperatorQueryError
    );
    await expect(service.agentConnections(FOREIGN_OWNER, 'agent-a')).rejects.toMatchObject({
      code: 'agent_not_found',
    });
  });

  it('shows canonical session detach and connection pause as disabled effective access', async () => {
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        state: 'detached',
        updatedAt: NOW,
      })
      .run();
    await expect(service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [
        { connectionId: 'connection-a', access: 'disabled', dominatingReason: 'session_detached' },
      ],
    });

    db.update(sessionConnectionOverrides)
      .set({ state: 'attached' })
      .where(eq(sessionConnectionOverrides.sessionId, 'session-a'))
      .run();
    db.update(connections).set({ enabled: false }).where(eq(connections.id, 'connection-a')).run();
    await expect(service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [{ access: 'disabled', dominatingReason: 'connection_paused' }],
    });
  });

  it('derives managed synchronization only from each scope current command', async () => {
    db.update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();
    db.insert(connectorManagedAuthorityOutbox)
      .values([
        {
          connectionId: 'connection-a',
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          ownerKind: OWNER.kind,
          ownerId: OWNER.installationId,
          commandId: 'old-rejected',
          managedConnectionId: 'private-account-a',
          scopeKind: 'connection_lifecycle',
          subjectId: 'connection',
          scopeVersion: 1,
          requestHash: 'old',
          requestJson: '{}',
          state: 'rejected',
          safeReason: 'Old failure',
          attemptCount: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          connectionId: 'connection-a',
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          ownerKind: OWNER.kind,
          ownerId: OWNER.installationId,
          commandId: 'current-applied',
          managedConnectionId: 'private-account-a',
          scopeKind: 'connection_lifecycle',
          subjectId: 'connection',
          scopeVersion: 2,
          requestHash: 'current',
          requestJson: '{}',
          state: 'applied',
          attemptCount: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ])
      .run();
    db.insert(connectorManagedAuthorityScopes)
      .values({
        managedConnectionId: 'private-account-a',
        scopeKind: 'connection_lifecycle',
        subjectId: 'connection',
        scopeVersion: 2,
        lastCommandId: 'current-applied',
        lastCommandHash: 'current',
        updatedAt: NOW,
      })
      .run();

    expect((await service.listConnections(OWNER))[0]?.authoritySync).toEqual({ status: 'ready' });
    db.update(connectorManagedAuthorityOutbox)
      .set({ state: 'pending' })
      .where(eq(connectorManagedAuthorityOutbox.commandId, 'current-applied'))
      .run();
    expect((await service.listConnections(OWNER))[0]?.authoritySync).toEqual({ status: 'pending' });
    // A stalled command says why it is waiting and when it tries again, on the
    // exact detail the account panel reads.
    const retryAt = '2026-09-06T18:05:00.000Z';
    db.update(connectorManagedAuthorityOutbox)
      .set({ safeReason: 'DorkOS’s servers had a problem.', nextAttemptAt: retryAt })
      .where(eq(connectorManagedAuthorityOutbox.commandId, 'current-applied'))
      .run();
    await expect(service.getConnection(OWNER, 'connection-a')).resolves.toMatchObject({
      connection: {
        authoritySync: { status: 'pending', reason: 'DorkOS’s servers had a problem.', retryAt },
      },
    });
    // The generic text an earlier version stored says nothing; it is no reason.
    db.update(connectorManagedAuthorityOutbox)
      .set({ safeReason: 'Managed connection synchronization is pending.' })
      .where(eq(connectorManagedAuthorityOutbox.commandId, 'current-applied'))
      .run();
    expect((await service.getConnection(OWNER, 'connection-a')).connection.authoritySync).toEqual({
      status: 'pending',
    });
    await expect(service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [{ access: 'disabled', dominatingReason: 'authority_sync_required' }],
    });
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        state: 'attached',
        updatedAt: NOW,
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'session-grant',
        subjectType: 'session',
        subjectId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: NOW,
      })
      .run();
    await expect(service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [{ access: 'disabled', dominatingReason: 'authority_sync_required' }],
    });
    db.update(connectorManagedAuthorityOutbox)
      .set({ state: 'applied' })
      .where(eq(connectorManagedAuthorityOutbox.commandId, 'current-applied'))
      .run();
    await expect(service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [
        { access: 'session_only', dominatingReason: 'none', operationRevisionIds: ['revision-a'] },
      ],
    });
  });

  it('uses hosted authoritative counts for managed connections and reports unavailability honestly', async () => {
    db.update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();
    const listManagedConnectorUsage = vi.fn().mockResolvedValue({
      version: 1,
      status: 'available',
      counts: { logicalOperationCount: 8, attemptCount: 11 },
      items: [],
    });
    const managedService = new ConnectorOperatorQueryService({
      db,
      registry,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => true },
      managedUsage: { listManagedConnectorUsage },
    });

    await expect(managedService.listConnections(OWNER)).resolves.toEqual([
      expect.objectContaining({
        usage: { status: 'available', logicalOperationCount: 8, attemptCount: 11 },
      }),
    ]);
    expect(listManagedConnectorUsage).toHaveBeenCalledWith(
      { version: 1, managedConnectionId: 'private-account-a', limit: 1 },
      expect.any(AbortSignal)
    );

    listManagedConnectorUsage.mockRejectedValueOnce(new Error('cloud unavailable'));
    await expect(managedService.listConnections(OWNER)).resolves.toEqual([
      expect.objectContaining({
        usage: { status: 'unavailable', reason: 'Managed usage is temporarily unavailable.' },
      }),
    ]);
  });
});

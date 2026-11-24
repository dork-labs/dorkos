import { describe, expect, it, vi } from 'vitest';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { ManagedConnectorCatalogRequestSchema } from '@dorkos/shared/connector-managed-discovery-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { requestManagedConnectorCatalog } from '../../../core/auth/cloud-link-client.js';
import {
  ManagedCloudConnectorProvider,
  type ManagedConnectorCloudPort,
} from '../../providers/managed/managed-cloud.js';
import { ConnectorOperatorQueryService } from '../../resources/operator-query-service.js';
import { ConnectionStore } from '../../connection-store.js';
import { ConnectorRegistry } from '../../registry.js';
import { OWNER, useOperatorQueryHarness } from './connector-operator-query-service.fixtures.js';

/** Reading the catalog: managed recovery, paging, one upstream listing, and message services. */
describe('ConnectorOperatorQueryService', () => {
  const h = useOperatorQueryHarness();

  it('refuses before managed recovery when canonical connector data is unavailable', async () => {
    const recoverManagedProvider = vi.fn<() => Promise<void>>().mockResolvedValue();
    const unavailableRegistry = new ConnectorRegistry({
      db: h.db,
      connectionStore: new ConnectionStore({
        db: h.db,
        runMigration: () => ({
          status: 'migration_failed',
          error: 'Connector data could not be upgraded.',
        }),
      }),
    });
    const unavailable = new ConnectorOperatorQueryService({
      db: h.db,
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
    h.registry.register(
      new ManagedCloudConnectorProvider({
        instanceId: ConnectorProviderInstanceIdSchema.parse('managed-cloud'),
        cloud,
        executionContext: () => undefined,
      }),
      'managed-material'
    );

    const catalog = await h.service.catalog({
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
    const listToolkitPage = vi.spyOn(h.provider, 'listToolkitPage');
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
    h.registry.register(bulk, 'material-bulk');
    const listings = (spy: typeof bulkPages) =>
      spy.mock.calls.filter(([request]) => request.cursor === undefined).length;

    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 5; page += 1) {
      const result = await h.service.catalog({
        limit: 24,
        ...(cursor !== undefined && { cursor }),
        signal: new AbortController().signal,
      });
      for (const entry of result.services) seen.add(entry.serviceSlug);
      cursor = result.nextCursor;
    }
    const search = await h.service.catalog({
      query: 'bulk 84',
      signal: new AbortController().signal,
    });
    await h.service.catalog({ query: 'gmail', signal: new AbortController().signal });
    await h.service.catalog({
      query: 'bulk',
      includeAuthenticationSetup: true,
      signal: new AbortController().signal,
    });
    const directory = await h.service.serviceDirectory(new AbortController().signal);

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

  it('projects negotiated setup without leaking it to released catalog clients', async () => {
    vi.spyOn(h.provider, 'listToolkitPage').mockResolvedValue({
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
    const legacy = await h.service.catalog({ signal: new AbortController().signal });
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
    const rich = await h.service.catalog({
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
    const capabilities = h.provider.getCapabilities();
    vi.spyOn(h.provider, 'getCapabilities').mockReturnValue({
      ...capabilities,
      capabilities: {
        ...capabilities.capabilities,
        authentication: {
          status: 'unsupported',
          reason: 'Managed connections are awaiting production verification.',
        },
      },
    });

    const catalog = await h.service.catalog({ signal: new AbortController().signal });
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

  it('gives agent requests the catalog read itself: recovery first, every page, Messaging marked', async () => {
    const recoveredRegistry = new ConnectorRegistry({
      db: h.db,
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
      db: h.db,
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
});

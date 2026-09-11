/** Provider-neutral discovery and legacy authority-surface removal. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { FakeConnectorProvider } from '@dorkos/test-utils';

import { connectorDomain, type ConnectorCapabilityDeps } from '../connector-capabilities.js';
import { ConnectorOperatorQueryService } from '../resources/operator-query-service.js';
import { ConnectionStore } from '../connection-store.js';
import { ConnectorRegistry } from '../registry.js';
import type { CapabilityDeps } from '../../core/capabilities/index.js';

const REMOVED_AUTHORITY_CAPABILITIES = [
  'connector.list_accounts',
  'connector.start_connect',
  'connector.poll_connect',
  'connector.attach_account',
  'connector.detach_account',
] as const;

function capability(id: string) {
  const found = connectorDomain.capabilities.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`connector domain does not declare ${id}`);
  return found;
}

describe('connector discovery capabilities', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let deps: CapabilityDeps;
  let queries: ConnectorOperatorQueryService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    registry.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
    queries = new ConnectorOperatorQueryService({
      db,
      registry,
      sessions: {
        resolveSessionAgent: () => {
          throw new Error('Private session lookup');
        },
      },
      agentOwnership: {
        ownsAgent: () => {
          throw new Error('Private owner lookup');
        },
      },
    });
    const connectorDeps: ConnectorCapabilityDeps = {
      registry,
      catalog: (input) => queries.catalog({ ...input, includeAuthenticationSetup: false }),
      relay: { getManifest: (type) => (type === 'slack' ? { displayName: 'Slack' } : undefined) },
    };
    deps = { logger: noopLogger, connectorDeps };
  });

  it('projects only nonprivate discovery on ordinary MCP surfaces', () => {
    expect(connectorDomain.capabilities.map((candidate) => candidate.id)).toEqual([
      'connector.list_toolkits',
      'connector.recommend',
    ]);
    for (const candidate of connectorDomain.capabilities) {
      expect(candidate.tier).toBe('observe');
      expect(candidate.surfaces.mcp).toMatchObject({
        servers: ['in-session', 'external'],
        readOnlyCarveOut: true,
      });
    }
    for (const removed of REMOVED_AUTHORITY_CAPABILITIES) {
      expect(connectorDomain.capabilities.some((candidate) => candidate.id === removed)).toBe(
        false
      );
    }
  });

  it('lists provider-neutral toolkits and recommends relay adapters before gateways', async () => {
    const listed = (await capability('connector.list_toolkits').invoke(deps, {}, {})) as {
      toolkits: Array<{ slug: string }>;
    };
    expect(listed.toolkits.map((toolkit) => toolkit.slug)).toContain('gmail');

    const recommended = (await capability('connector.recommend').invoke(
      deps,
      { service: 'slack' },
      {}
    )) as { recommendations: Array<{ kind: string }> };
    expect(recommended.recommendations.map((candidate) => candidate.kind)).toEqual([
      'relay-adapter',
      'gateway',
    ]);
  });

  it('pages more than 100 services through the bounded catalog without legacy or private reads', async () => {
    const provider = new FakeConnectorProvider({
      type: 'paged',
      custody: 'managed',
      toolkits: Array.from({ length: 125 }, (_, index) => ({
        slug: `service-${String(index).padStart(3, '0')}`,
        displayName: `Service ${String(index).padStart(3, '0')}`,
        authKind: 'oauth2' as const,
      })),
    });
    registry.register(provider);
    const legacy = vi
      .spyOn(provider, 'listToolkits')
      .mockRejectedValue(new Error('Legacy catalog truncated'));
    const accounts = vi
      .spyOn(provider, 'listAccounts')
      .mockRejectedValue(new Error('Private account read'));
    const pages = vi.spyOn(provider, 'listToolkitPage');
    const invoke = async (input: Record<string, unknown>) =>
      capability('connector.list_toolkits').invoke(deps, input, {}) as Promise<{
        toolkits: Array<{ slug: string }>;
        nextCursor?: string;
        warnings: unknown[];
      }>;
    const first = await invoke({ query: 'Service', limit: 100 });
    expect(first.toolkits).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const second = await invoke({ query: 'Service', limit: 100, cursor: first.nextCursor });
    expect(second.toolkits).toHaveLength(25);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.toolkits, ...second.toolkits].map(({ slug }) => slug)).size).toBe(125);
    expect(first.warnings).toEqual([]);
    expect(pages.mock.calls.some(([input]) => input.cursor === '100')).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
    expect(accounts).not.toHaveBeenCalled();
    await expect(invoke({ query: 'different', cursor: first.nextCursor })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
  });

  it('omits sign-in setup even when provider metadata supplies it', async () => {
    const provider = new FakeConnectorProvider({
      type: 'setup',
      custody: 'managed',
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
    registry.register(provider);
    const result = await capability('connector.list_toolkits').invoke(deps, {}, {});
    expect(JSON.stringify(result)).not.toContain('authenticationSetup');
    expect(result).toMatchObject({
      toolkits: expect.arrayContaining([
        { slug: 'synthetic', displayName: 'Synthetic', authKind: 'api-key' },
      ]),
    });
  });

  it('preserves truthful catalog warnings and refuses account/setup input', async () => {
    const provider = new FakeConnectorProvider({ type: 'unreachable', custody: 'managed' });
    registry.register(provider);
    vi.spyOn(provider, 'listToolkitPage').mockRejectedValue(new Error('private provider error'));
    const result = await capability('connector.list_toolkits').invoke(deps, {}, {});
    expect(result).toMatchObject({
      warnings: [{ code: 'catalog_provider_unavailable', provider: 'catalog' }],
    });
    expect(JSON.stringify(result)).not.toContain('private provider error');
    const schema = capability('connector.list_toolkits').input;
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { includeAuthenticationSetup: true },
      { ownerId: 'other' },
      { connectionId: 'private' },
    ]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
  });

  it('fails closed when canonical connector migration health is unavailable', async () => {
    const unavailableRegistry = new ConnectorRegistry({
      db,
      connectionStore: new ConnectionStore({
        db,
        runMigration: () => ({
          status: 'migration_failed',
          error: 'Connector data could not be upgraded. Connector changes are unavailable.',
        }),
      }),
    });
    const unavailableDeps: CapabilityDeps = {
      logger: noopLogger,
      connectorDeps: { registry: unavailableRegistry, catalog: (input) => queries.catalog(input) },
    };

    for (const [id, input] of [
      ['connector.list_toolkits', {}],
      ['connector.recommend', { service: 'gmail' }],
    ] as const) {
      await expect(capability(id).invoke(unavailableDeps, input, {})).rejects.toMatchObject({
        code: 'migration_failed',
        message: 'Connector data could not be upgraded. Connector changes are unavailable.',
      });
    }
  });
});

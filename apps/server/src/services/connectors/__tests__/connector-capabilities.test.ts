/** Provider-neutral discovery and legacy authority-surface removal. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { FakeConnectorProvider } from '@dorkos/test-utils';

import { connectorDomain, type ConnectorCapabilityDeps } from '../connector-capabilities.js';
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

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    registry.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
    const connectorDeps: ConnectorCapabilityDeps = {
      registry,
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
      connectorDeps: { registry: unavailableRegistry },
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

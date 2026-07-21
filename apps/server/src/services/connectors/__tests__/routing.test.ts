import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../registry.js';
import { recommendConnector, type RelayAdapterCatalog } from '../routing.js';

/** A relay catalog with a purpose-built adapter only for the given slugs. */
function relayWith(slugs: Record<string, string>): RelayAdapterCatalog {
  return {
    getManifest(type: string) {
      return slugs[type] ? { displayName: slugs[type] } : undefined;
    },
  };
}

describe('recommendConnector', () => {
  let db: Db;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    // Composio (managed gateway) lists gmail + slack by default.
    registry.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
  });

  it('routes "slack" to the relay adapter FIRST, above any gateway (the W4 crux)', async () => {
    const recs = await recommendConnector('slack', {
      registry,
      relay: relayWith({ slack: 'Slack' }),
    });

    expect(recs[0]).toMatchObject({ kind: 'relay-adapter', target: 'slack', rank: 0 });
    // A gateway entry still exists, but ranked strictly below the relay adapter.
    const gateway = recs.find((r) => r.kind === 'gateway');
    expect(gateway).toBeDefined();
    expect(recs[0]!.rank).toBeLessThan(gateway!.rank);
  });

  it('routes "gmail" to the gateway FIRST (no relay adapter for Gmail)', async () => {
    const recs = await recommendConnector('gmail', {
      registry,
      relay: relayWith({ slack: 'Slack' }),
    });

    expect(recs[0]).toMatchObject({ kind: 'gateway', target: 'gmail', provider: 'composio' });
    expect(recs.some((r) => r.kind === 'relay-adapter')).toBe(false);
  });

  it('carries custody on the gateway recommendation so the picker can disclose', async () => {
    const recs = await recommendConnector('gmail', { registry });
    expect(recs[0]!.custody).toBe('managed');
  });

  it('prefers the managed gateway over a self-host gateway for the same service', async () => {
    registry.register(new FakeConnectorProvider({ type: 'nango', custody: 'self-host' }));

    const recs = await recommendConnector('gmail', { registry });
    const gateways = recs.filter((r) => r.kind === 'gateway');
    expect(gateways.map((g) => g.provider)).toEqual(['composio', 'nango']);
    expect(recs[0]!.provider).toBe('composio');
  });

  it('routes a service with only an external-custody baseline to raw-mcp', async () => {
    registry.register(
      new FakeConnectorProvider({
        type: 'mcp',
        custody: 'external',
        toolkits: [{ slug: 'notion', displayName: 'Notion', authKind: 'oauth2' }],
      })
    );

    const recs = await recommendConnector('notion', { registry });
    expect(recs[0]).toMatchObject({ kind: 'raw-mcp', target: 'notion', custody: 'external' });
  });

  it('returns an empty list when nothing can connect the service', async () => {
    const recs = await recommendConnector('salesforce', {
      registry,
      relay: relayWith({ slack: 'Slack' }),
    });
    expect(recs).toEqual([]);
  });

  it('reads the relay catalog only through the public getManifest accessor', async () => {
    let asked: string | undefined;
    const relay: RelayAdapterCatalog = {
      getManifest(type: string) {
        asked = type;
        return type === 'slack' ? { displayName: 'Slack' } : undefined;
      },
    };
    await recommendConnector('slack', { registry, relay });
    expect(asked).toBe('slack');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type {
  ConnectedAccount,
  ConnectorCapabilities,
  ConnectorProvider,
  ConnectorToolkit,
  ConnectPoll,
  ConnectStart,
} from '@dorkos/shared/connector-provider';
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

/** A gateway provider whose `listToolkits` never resolves — the hung-provider case. */
class HungProvider implements ConnectorProvider {
  readonly type = 'hung';
  getCapabilities(): ConnectorCapabilities {
    return {
      type: this.type,
      supportsMultiAccount: true,
      custody: 'managed',
      exposesOverMcp: true,
      features: {},
    };
  }
  listToolkits(): Promise<ConnectorToolkit[]> {
    return new Promise<ConnectorToolkit[]>(() => {});
  }
  startConnect(): Promise<ConnectStart> {
    return Promise.reject(new Error('hung'));
  }
  pollConnect(): Promise<ConnectPoll> {
    return Promise.resolve({ status: 'failed', error: 'hung' });
  }
  listAccounts(): Promise<ConnectedAccount[]> {
    return Promise.resolve([]);
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  toolServerForAccount() {
    return Promise.resolve(null);
  }
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
    const { recommendations } = await recommendConnector('slack', {
      registry,
      relay: relayWith({ slack: 'Slack' }),
    });

    expect(recommendations[0]).toMatchObject({ kind: 'relay-adapter', target: 'slack', rank: 0 });
    const gateway = recommendations.find((r) => r.kind === 'gateway');
    expect(gateway).toBeDefined();
    expect(recommendations[0]!.rank).toBeLessThan(gateway!.rank);
  });

  it('routes "gmail" to the gateway FIRST (no relay adapter for Gmail)', async () => {
    const { recommendations } = await recommendConnector('gmail', {
      registry,
      relay: relayWith({ slack: 'Slack' }),
    });

    expect(recommendations[0]).toMatchObject({
      kind: 'gateway',
      target: 'gmail',
      provider: 'composio',
    });
    expect(recommendations.some((r) => r.kind === 'relay-adapter')).toBe(false);
  });

  it('carries custody on the gateway recommendation so the picker can disclose', async () => {
    const { recommendations } = await recommendConnector('gmail', { registry });
    expect(recommendations[0]!.custody).toBe('managed');
  });

  it('prefers the managed gateway over a self-host gateway for the same service', async () => {
    registry.register(new FakeConnectorProvider({ type: 'nango', custody: 'self-host' }));

    const { recommendations } = await recommendConnector('gmail', { registry });
    const gateways = recommendations.filter((r) => r.kind === 'gateway');
    expect(gateways.map((g) => g.provider)).toEqual(['composio', 'nango']);
    expect(recommendations[0]!.provider).toBe('composio');
  });

  it('routes a service with only an external-custody baseline to raw-mcp', async () => {
    registry.register(
      new FakeConnectorProvider({
        type: 'mcp',
        custody: 'external',
        toolkits: [{ slug: 'notion', displayName: 'Notion', authKind: 'oauth2' }],
      })
    );

    const { recommendations } = await recommendConnector('notion', { registry });
    expect(recommendations[0]).toMatchObject({
      kind: 'raw-mcp',
      target: 'notion',
      custody: 'external',
    });
  });

  it('returns empty recommendations + no warnings when nothing can connect the service', async () => {
    const { recommendations, warnings } = await recommendConnector('salesforce', {
      registry,
      relay: relayWith({ slack: 'Slack' }),
    });
    expect(recommendations).toEqual([]);
    expect(warnings).toEqual([]);
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

  it('degrades a hung provider to a warning instead of blocking (bounded by the registry timeout)', async () => {
    // A short timeout keeps the test fast; the hung provider never resolves
    // listToolkits, so without the timeout this call would hang forever.
    const bounded = new ConnectorRegistry({ db, providerTimeoutMs: 50 });
    bounded.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
    bounded.register(new HungProvider());

    const start = Date.now();
    const { recommendations, warnings } = await recommendConnector('gmail', { registry: bounded });
    const elapsed = Date.now() - start;

    // The reachable gateway still returns...
    expect(recommendations[0]).toMatchObject({ kind: 'gateway', provider: 'composio' });
    // ...and the hung provider is surfaced as a warning, not a hang.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.provider).toBe('hung');
    expect(warnings[0]!.message).toMatch(/timed out/);
    expect(elapsed).toBeLessThan(2000);
  });
});

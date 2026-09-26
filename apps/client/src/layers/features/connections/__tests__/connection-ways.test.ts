import { describe, expect, it } from 'vitest';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { appCount, groupAppsByWay, keyWayName } from '../lib/connection-ways';

function connection(over: Partial<ConnectorConnectionSummary>): ConnectorConnectionSummary {
  return {
    connectionId: 'c1' as never,
    providerInstanceId: 'cpi_x' as never,
    toolkit: 'gmail',
    label: 'work',
    identityHint: null,
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'byo',
    custody: 'managed',
    payer: 'operator_byo',
    agentCount: 1,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    warnings: [],
    ...over,
  };
}

function provider(over: Partial<ConnectorProviderStatus>): ConnectorProviderStatus {
  return {
    type: 'composio',
    configured: true,
    registered: true,
    custody: 'managed',
    disclosure: 'Composio keeps your login access in its own secure vault.',
    ...over,
  };
}

const composio = provider({});
const nango = provider({ type: 'nango', custody: 'self-host' });

describe('groupAppsByWay', () => {
  it('puts DorkOS-paid apps on the account and BYO apps on the key of their custody', () => {
    const grouped = groupAppsByWay(
      [
        connection({ connectionId: 'a' as never, mode: 'managed', payer: 'dorkos_managed' }),
        connection({ connectionId: 'b' as never, toolkit: 'notion', label: 'team' }),
        connection({ connectionId: 'c' as never, custody: 'self-host', toolkit: 'linear' }),
      ],
      [composio, nango]
    );
    expect(grouped.dorkosAccount.map((app) => app.connectionId)).toEqual(['a']);
    expect(grouped.byKeyType.composio).toEqual([
      { connectionId: 'b', name: 'Notion (team)', agentCount: 1 },
    ]);
    expect(grouped.byKeyType.nango?.map((app) => app.name)).toEqual(['Linear (work)']);
  });

  it('leaves out disconnected apps and raw servers nobody sets up here', () => {
    const grouped = groupAppsByWay(
      [
        connection({ lifecycle: 'disconnected' }),
        connection({ connectionId: 'raw' as never, custody: 'external' }),
        connection({ connectionId: 'paused' as never, lifecycle: 'paused' }),
      ],
      [composio, nango]
    );
    expect(grouped.dorkosAccount).toEqual([]);
    expect(grouped.byKeyType.composio?.map((app) => app.connectionId)).toEqual(['paused']);
    expect(grouped.byKeyType.nango).toBeUndefined();
  });

  it('prefers the working key when two keys share a custody', () => {
    const scripted = provider({ type: 'test-connector', configured: true, registered: true });
    const grouped = groupAppsByWay(
      [connection({})],
      [provider({ configured: false, registered: false }), scripted]
    );
    expect(Object.keys(grouped.byKeyType)).toEqual(['test-connector']);
  });

  it('still attributes apps to a key that was removed, so the row can say they stopped', () => {
    const grouped = groupAppsByWay(
      [connection({})],
      [provider({ configured: false, registered: false })]
    );
    expect(grouped.byKeyType.composio).toHaveLength(1);
  });
});

describe('naming', () => {
  it('counts apps and names each way in plain words', () => {
    expect(appCount(1)).toBe('1 app');
    expect(appCount(4)).toBe('4 apps');
    expect(keyWayName('composio')).toBe('Your Composio key');
    expect(keyWayName('nango')).toBe('Your Nango server');
  });
});

import { describe, expect, it } from 'vitest';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { appCount, splitByImpact } from '@/layers/entities/connectors';
import { groupAppsByWay, keyWayName } from '../lib/connection-ways';

function connection(over: Partial<ConnectorConnectionSummary>): ConnectorConnectionSummary {
  return {
    connectionId: 'c1' as never,
    providerInstanceId: 'cpi_composio' as never,
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
    providerInstanceId: 'cpi_composio' as never,
    configured: true,
    registered: true,
    custody: 'managed',
    disclosure: 'Composio keeps your login access in its own secure vault.',
    ...over,
  };
}

const composio = provider({});
const nango = provider({
  type: 'nango',
  providerInstanceId: 'cpi_nango' as never,
  custody: 'self-host',
});

describe('groupAppsByWay', () => {
  it('puts DorkOS-paid apps on the account and BYO apps on the key instance they carry', () => {
    const grouped = groupAppsByWay(
      [
        connection({ connectionId: 'a' as never, mode: 'managed', payer: 'dorkos_managed' }),
        connection({ connectionId: 'b' as never, toolkit: 'notion', label: 'team' }),
        connection({
          connectionId: 'c' as never,
          providerInstanceId: 'cpi_nango' as never,
          toolkit: 'linear',
        }),
      ],
      [composio, nango]
    );
    expect(grouped.dorkosAccount.map((app) => app.connectionId)).toEqual(['a']);
    expect(grouped.byKeyInstance.cpi_composio).toEqual([
      { connectionId: 'b', name: 'Notion (team)', agentCount: 1, active: true },
    ]);
    expect(grouped.byKeyInstance.cpi_nango?.map((app) => app.name)).toEqual(['Linear (work)']);
  });

  it('leaves out disconnected apps and connections on no listed key', () => {
    const grouped = groupAppsByWay(
      [
        connection({ lifecycle: 'disconnected' }),
        connection({ connectionId: 'raw' as never, providerInstanceId: 'cpi_raw' as never }),
        connection({ connectionId: 'paused' as never, lifecycle: 'paused' }),
      ],
      [composio, nango]
    );
    expect(grouped.dorkosAccount).toEqual([]);
    expect(grouped.byKeyInstance.cpi_composio?.map((app) => app.connectionId)).toEqual(['paused']);
    expect(grouped.byKeyInstance.cpi_composio?.[0]?.active).toBe(false);
    expect(grouped.byKeyInstance.cpi_raw).toBeUndefined();
  });

  it('keeps two keys of the same kind apart', () => {
    const grouped = groupAppsByWay(
      [
        connection({ connectionId: 'a' as never }),
        connection({ connectionId: 'b' as never, providerInstanceId: 'cpi_second' as never }),
      ],
      [composio, provider({ providerInstanceId: 'cpi_second' as never })]
    );
    expect(grouped.byKeyInstance.cpi_composio?.map((app) => app.connectionId)).toEqual(['a']);
    expect(grouped.byKeyInstance.cpi_second?.map((app) => app.connectionId)).toEqual(['b']);
  });
});

describe('splitByImpact', () => {
  const apps = [
    { connectionId: 'a', name: 'Gmail (work)', agentCount: 1, active: true },
    { connectionId: 'b', name: 'Notion (team)', agentCount: 0, active: false },
  ];

  it('counts only working apps as stopping when the way works', () => {
    const { stopping, idle } = splitByImpact(apps, true);
    expect(stopping.map((app) => app.connectionId)).toEqual(['a']);
    expect(idle.map((app) => app.connectionId)).toEqual(['b']);
  });

  it('counts nothing as stopping when the way already does not work', () => {
    const { stopping, idle } = splitByImpact(apps, false);
    expect(stopping).toEqual([]);
    expect(idle).toHaveLength(2);
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

import { describe, expect, it } from 'vitest';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { appCount, splitByImpact } from '@/layers/entities/connectors';
import { groupAppsByWay } from '../lib/connection-ways';
import { createMockConnectionReadiness } from '@dorkos/test-utils';

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
    everyAgent: null,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    readiness: createMockConnectionReadiness(),
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
      { connectionId: 'b', name: 'Notion (team)', agentCount: 1, everyAgent: false, usable: true },
    ]);
    expect(grouped.byKeyInstance.cpi_nango?.map((app) => app.name)).toEqual(['Linear (work)']);
  });

  it('leaves out disconnected apps and connections on no listed key', () => {
    const grouped = groupAppsByWay(
      [
        connection({
          lifecycle: 'disconnected',
          readiness: createMockConnectionReadiness({ state: 'gone', reason: 'disconnected' }),
        }),
        connection({ connectionId: 'raw' as never, providerInstanceId: 'cpi_raw' as never }),
        connection({
          connectionId: 'paused' as never,
          lifecycle: 'paused',
          readiness: createMockConnectionReadiness({
            state: 'paused',
            reason: 'paused',
            fix: { action: 'resume', fixableBy: 'person' },
          }),
        }),
      ],
      [composio, nango]
    );
    expect(grouped.dorkosAccount).toEqual([]);
    expect(grouped.byKeyInstance.cpi_composio?.map((app) => app.connectionId)).toEqual(['paused']);
    expect(grouped.byKeyInstance.cpi_composio?.[0]?.usable).toBe(false);
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
    { connectionId: 'a', name: 'Gmail (work)', agentCount: 1, everyAgent: false, usable: true },
    { connectionId: 'b', name: 'Notion (team)', agentCount: 0, everyAgent: false, usable: false },
  ];

  it('counts only apps agents can use now as stopping, from their readiness', () => {
    const { stopping, idle } = splitByImpact(apps);
    expect(stopping.map((app) => app.connectionId)).toEqual(['a']);
    expect(idle.map((app) => app.connectionId)).toEqual(['b']);
  });

  it('reads usable from the server’s readiness, not the lifecycle', () => {
    const cutOff = connection({
      readiness: createMockConnectionReadiness({
        state: 'needs_you',
        reason: 'own_key_unavailable',
        fix: { action: 'fix_key', fixableBy: 'person' },
      }),
    });
    expect(groupAppsByWay([cutOff], [composio]).byKeyInstance.cpi_composio?.[0]?.usable).toBe(
      false
    );
  });
});

describe('naming', () => {
  it('counts apps in plain words', () => {
    expect(appCount(1)).toBe('1 app');
    expect(appCount(4)).toBe('4 apps');
  });
});

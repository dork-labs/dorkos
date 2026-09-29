import { describe, expect, it, vi } from 'vitest';
import type { ConnectorAppWay } from '@dorkos/shared/connector-resource-schemas';
import {
  CONNECTION_CLOSED_BY_NEW_LINK_EVENT,
  recordConnectionsClosedByNewLink,
  agentAppSetupNote,
  appReachProblem,
  chooseNewAppsWay,
  signInThroughFor,
  wayProblemFor,
} from '../app-connection-way.js';

const dorkosAccount = (status: ConnectorAppWay['status']): ConnectorAppWay => ({
  kind: 'dorkos_account',
  type: 'dorkos-managed',
  status,
  ...(status === 'ready' && { providerInstanceId: 'managed' as never }),
});
const ownKey = (type: string, status: ConnectorAppWay['status']): ConnectorAppWay => ({
  kind: 'own_key',
  type,
  status,
  ...(status === 'ready' && { providerInstanceId: type as never }),
});

describe('chooseNewAppsWay', () => {
  it('asks for the one-time step when nothing is set up', () => {
    expect(chooseNewAppsWay([])).toEqual({ status: 'setup_needed', reason: 'nothing_set_up' });
  });

  it('uses the only working way without asking', () => {
    expect(chooseNewAppsWay([dorkosAccount('ready')])).toEqual({
      status: 'ready',
      way: dorkosAccount('ready'),
    });
    expect(chooseNewAppsWay([ownKey('nango', 'ready')])).toEqual({
      status: 'ready',
      way: ownKey('nango', 'ready'),
    });
  });

  it('prefers the person’s own key when both work, whatever order they arrive in', () => {
    expect(chooseNewAppsWay([dorkosAccount('ready'), ownKey('composio', 'ready')])).toMatchObject({
      way: { kind: 'own_key', type: 'composio' },
    });
    expect(chooseNewAppsWay([ownKey('composio', 'ready'), dorkosAccount('ready')])).toMatchObject({
      way: { kind: 'own_key', type: 'composio' },
    });
  });

  it('takes the first working own key, and skips one that is not answering', () => {
    expect(
      chooseNewAppsWay([ownKey('composio', 'unavailable'), ownKey('nango', 'ready')])
    ).toMatchObject({ way: { type: 'nango' } });
    expect(chooseNewAppsWay([ownKey('composio', 'ready'), ownKey('nango', 'ready')])).toMatchObject(
      { way: { type: 'composio' } }
    );
  });

  it('falls back to a working DorkOS account when the own key is not answering', () => {
    expect(
      chooseNewAppsWay([ownKey('composio', 'unavailable'), dorkosAccount('ready')])
    ).toMatchObject({ status: 'ready', way: { kind: 'dorkos_account' } });
  });

  it('says why when something is set up but nothing works', () => {
    expect(chooseNewAppsWay([dorkosAccount('unavailable')])).toEqual({
      status: 'setup_needed',
      reason: 'dorkos_account_unavailable',
    });
    expect(chooseNewAppsWay([ownKey('composio', 'unavailable')])).toEqual({
      status: 'setup_needed',
      reason: 'own_key_unavailable',
    });
    expect(chooseNewAppsWay([dorkosAccount('unlinked'), ownKey('nango', 'unavailable')])).toEqual({
      status: 'setup_needed',
      reason: 'dorkos_account_unlinked',
    });
  });

  it('prefers a way agents can act through over a key that can only sign in', () => {
    const signInOnly: ConnectorAppWay = { ...ownKey('composio', 'ready'), canRunActions: false };
    const account: ConnectorAppWay = { ...dorkosAccount('ready'), canRunActions: true };
    expect(chooseNewAppsWay([signInOnly, account])).toEqual({ status: 'ready', way: account });
    // With nothing better, the sign-in-only key still connects apps.
    expect(chooseNewAppsWay([signInOnly])).toEqual({ status: 'ready', way: signInOnly });
  });

  it('uses a working key while the DorkOS account is unlinked', () => {
    expect(
      chooseNewAppsWay([dorkosAccount('unlinked'), ownKey('composio', 'ready')])
    ).toMatchObject({ status: 'ready', way: { kind: 'own_key' } });
  });
});

describe('appReachProblem', () => {
  it('passes a setup reason through, and splits a working way into outage or miss', () => {
    expect(appReachProblem({ status: 'setup_needed', reason: 'own_key_unavailable' }, true)).toBe(
      'own_key_unavailable'
    );
    const way = ownKey('composio', 'ready');
    expect(appReachProblem({ status: 'ready', way }, true)).toBe('way_not_answering');
    expect(appReachProblem({ status: 'ready', way }, false)).toBe('app_not_reached');
  });
});

describe('wayProblemFor', () => {
  it('is nothing while the route is registered, whatever the account link says', () => {
    expect(
      wayProblemFor({ registered: true, managed: true, managedLinked: false })
    ).toBeUndefined();
  });

  it('tells an unlinked DorkOS account from one that cannot reach apps, and from a key', () => {
    expect(wayProblemFor({ registered: false, managed: true, managedLinked: false })).toBe(
      'dorkos_account_unlinked'
    );
    expect(wayProblemFor({ registered: false, managed: true, managedLinked: true })).toBe(
      'dorkos_account_unavailable'
    );
    expect(wayProblemFor({ registered: false, managed: false, managedLinked: true })).toBe(
      'own_key_unavailable'
    );
  });
});

describe('agent notes', () => {
  it('names the app and says it can still be asked for, for every reason', () => {
    for (const problem of [
      'nothing_set_up',
      'dorkos_account_unlinked',
      'dorkos_account_unavailable',
      'own_key_unavailable',
      'way_not_answering',
      'app_not_reached',
    ] as const) {
      const note = agentAppSetupNote(problem, 'Gmail');
      expect(note).toContain('Gmail');
      expect(note).toContain('still request');
    }
  });
});

describe('signInThroughFor', () => {
  it('names Composio for the DorkOS account route, which runs on it', () => {
    expect(signInThroughFor('dorkos-managed')).toBe('Composio');
    expect(signInThroughFor('composio')).toBe('Composio');
  });

  it('names nothing for a route that signs in directly or with the person’s own OAuth app', () => {
    // Self-hosted Nango signs in with the OAuth app the person registered.
    expect(signInThroughFor('nango')).toBeUndefined();
    expect(signInThroughFor('mcp')).toBeUndefined();
    expect(signInThroughFor('test-connector')).toBeUndefined();
  });
});

describe('recordConnectionsClosedByNewLink', () => {
  it('writes one plain entry per closed account, linking to that app', async () => {
    const emit = vi.fn();
    await recordConnectionsClosedByNewLink({ emit }, [
      { connectionId: 'connection-1' as never, toolkit: 'gmail', label: 'work' },
      { connectionId: 'connection-2' as never, toolkit: 'notion', label: 'team' },
    ]);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actorType: 'system',
        eventType: CONNECTION_CLOSED_BY_NEW_LINK_EVENT,
        resourceId: 'connection-1',
        resourceLabel: 'Gmail (work)',
        summary:
          "Gmail (work) was closed: it was connected through your DorkOS account's earlier link, which the new link can't reach. Connect it again to use it.",
        linkPath: '/connections?app=connection-1',
      })
    );
    expect(emit.mock.calls[1]![0].summary).toMatch(/^Notion \(team\) was closed/);
  });

  it('writes nothing when nothing was closed', async () => {
    const emit = vi.fn();
    await recordConnectionsClosedByNewLink({ emit }, []);
    expect(emit).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import type { ConnectorAppWay } from '@dorkos/shared/connector-resource-schemas';
import { chooseNewAppsWay, signInThroughFor } from '../app-connection-way.js';

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

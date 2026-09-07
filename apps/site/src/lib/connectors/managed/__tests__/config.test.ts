import { describe, expect, it } from 'vitest';

import { managedCapabilityAvailability, readManagedConnectorConfig } from '../config';

describe('managed connector configuration', () => {
  it('fails closed while preserving per-capability availability', () => {
    const config = readManagedConnectorConfig({
      DORKOS_MANAGED_CONNECTORS_ENABLED: '1',
      DORKOS_MANAGED_CONNECTORS_LIVE_READY: '1',
      DORKOS_MANAGED_COMPOSIO_PROJECT_KEY: 'ck_test',
      DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN: 'https://dorkos.test',
      DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS: JSON.stringify({ gmail: 'ac_gmail' }),
    });

    expect(managedCapabilityAvailability(config, 'catalog')).toEqual({ status: 'available' });
    expect(managedCapabilityAvailability(config, 'execution')).toEqual({ status: 'available' });
    expect(managedCapabilityAvailability(config, 'authentication', 'gmail')).toEqual({
      status: 'available',
    });
    expect(managedCapabilityAvailability(config, 'authentication', 'slack')).toEqual({
      status: 'unavailable',
      reason: 'Managed account sign-in is not available for this service yet.',
    });
    expect(managedCapabilityAvailability(config, 'events')).toEqual({
      status: 'unavailable',
      reason: 'Managed account events are not configured yet.',
    });
  });

  it('does not parse a malformed auth-config map optimistically', () => {
    expect(() =>
      readManagedConnectorConfig({
        DORKOS_MANAGED_CONNECTORS_ENABLED: '1',
        DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS: '[]',
      })
    ).toThrow('Managed connector configuration is invalid.');
  });

  it('keeps every capability unavailable until the production smoke is complete', () => {
    const config = readManagedConnectorConfig({
      DORKOS_MANAGED_CONNECTORS_ENABLED: '1',
      DORKOS_MANAGED_COMPOSIO_PROJECT_KEY: 'ck_test',
    });
    expect(managedCapabilityAvailability(config, 'execution')).toEqual({
      status: 'unavailable',
      reason: 'Managed connections are awaiting production verification.',
    });
  });

  it('rejects a non-HTTPS public callback origin without echoing it', () => {
    const unsafe = 'http://public.example/private-callback';
    let message = '';
    try {
      readManagedConnectorConfig({
        DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN: unsafe,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Managed connector configuration is invalid.');
    expect(message).not.toContain(unsafe);
  });

  it('keeps the browser callback at one canonical HTTPS origin', () => {
    expect(
      readManagedConnectorConfig({
        DORKOS_MANAGED_CONNECTORS_ENABLED: '1',
        DORKOS_MANAGED_CONNECTORS_LIVE_READY: '1',
        DORKOS_MANAGED_COMPOSIO_PROJECT_KEY: 'project-key',
        DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN: 'https://dorkos.test/',
      }).callbackOrigin
    ).toBe('https://dorkos.test');

    for (const callbackOrigin of [
      'https://dorkos.test/other',
      'https://dorkos.test?next=other',
      'https://user:password@dorkos.test',
    ]) {
      expect(() =>
        readManagedConnectorConfig({
          DORKOS_MANAGED_CONNECTORS_ENABLED: '1',
          DORKOS_MANAGED_CONNECTORS_LIVE_READY: '1',
          DORKOS_MANAGED_COMPOSIO_PROJECT_KEY: 'project-key',
          DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN: callbackOrigin,
        })
      ).toThrow('Managed connector configuration is invalid.');
    }
  });
});

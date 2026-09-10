/** @vitest-environment node */
import type { ComposioOperationClient } from '@dorkos/connector-providers/composio';
import type { ConnectorToolkit } from '@dorkos/shared/connector-provider';
import { describe, expect, it, vi } from 'vitest';

import type { ManagedConnectorConfig } from '../config';
import { listManagedConnectorCatalog } from '../discovery-service';

const readyConfig: ManagedConnectorConfig = {
  enabled: true,
  liveReady: true,
  projectApiKey: 'project-fixture',
  callbackOrigin: 'https://dorkos.example',
  authConfigByToolkit: {},
};

function operationsFor(toolkits: ConnectorToolkit[]): ComposioOperationClient {
  return {
    listToolkitPage: vi.fn(async () => ({ toolkits, truncated: false })),
  } as unknown as ComposioOperationClient;
}

describe('managed catalog authentication presentation', () => {
  it('presents managed OAuth, account fields, no-auth confirmation, and unsupported methods', async () => {
    const toolkits: ConnectorToolkit[] = [
      {
        slug: 'gmail',
        displayName: 'Gmail',
        authKind: 'oauth2',
        authenticationSetup: {
          kind: 'oauth',
          source: 'managed',
          scheme: 'OAUTH2',
          requiresAccountFields: false,
        },
      },
      {
        slug: 'linear',
        displayName: 'Linear',
        authKind: 'api-key',
        authenticationSetup: {
          kind: 'fields',
          source: 'account-fields',
          scheme: 'API_KEY',
          requiresAccountFields: true,
        },
      },
      {
        slug: 'public_data',
        displayName: 'Public Data',
        authKind: 'none',
        authenticationSetup: {
          kind: 'none',
          source: 'account-fields',
          scheme: 'NO_AUTH',
          requiresAccountFields: false,
        },
      },
      {
        slug: 'legacy_oauth',
        displayName: 'Legacy OAuth',
        authKind: 'none',
        authenticationSetup: {
          kind: 'unsupported',
          source: 'unsupported',
          scheme: 'OAUTH1',
          requiresAccountFields: false,
        },
      },
    ];

    const page = await listManagedConnectorCatalog({
      includeAuthenticationSetup: true,
      operations: operationsFor(toolkits),
      config: readyConfig,
      rawRequest: { version: 1, limit: 20 },
      signal: AbortSignal.timeout(1_000),
    });

    expect(page.toolkits).toEqual([
      expect.objectContaining({
        slug: 'gmail',
        authenticationSetup: expect.objectContaining({ kind: 'oauth', source: 'managed' }),
        authentication: { status: 'available' },
      }),
      expect.objectContaining({
        slug: 'linear',
        authenticationSetup: expect.objectContaining({ kind: 'fields', scheme: 'API_KEY' }),
        authentication: { status: 'available' },
      }),
      expect.objectContaining({
        slug: 'public_data',
        authenticationSetup: expect.objectContaining({ kind: 'none', scheme: 'NO_AUTH' }),
        authentication: { status: 'available' },
      }),
      expect.objectContaining({
        slug: 'legacy_oauth',
        authenticationSetup: expect.objectContaining({ kind: 'unsupported', scheme: 'OAUTH1' }),
        authentication: {
          status: 'unsupported',
          reason: 'This service uses OAUTH1, which DorkOS does not support yet.',
        },
      }),
    ]);
  });

  it('keeps a declared field override authoritative and preserves the strict legacy wire', async () => {
    const toolkit: ConnectorToolkit = {
      slug: 'gmail',
      displayName: 'Gmail',
      authKind: 'api-key',
      authenticationSetup: {
        kind: 'fields',
        source: 'account-fields',
        scheme: 'API_KEY',
        requiresAccountFields: true,
      },
    };
    const config = { ...readyConfig, authConfigByToolkit: { gmail: 'configured-auth' } };
    const rich = await listManagedConnectorCatalog({
      includeAuthenticationSetup: true,
      operations: operationsFor([toolkit]),
      config,
      rawRequest: { version: 1, limit: 20 },
      signal: AbortSignal.timeout(1_000),
    });
    const legacy = await listManagedConnectorCatalog({
      operations: operationsFor([toolkit]),
      config,
      rawRequest: { version: 1, limit: 20 },
      signal: AbortSignal.timeout(1_000),
    });

    expect(rich.toolkits[0]).toEqual(
      expect.objectContaining({
        authKind: 'api-key',
        authenticationSetup: {
          kind: 'fields',
          source: 'configured',
          scheme: 'API_KEY',
          requiresAccountFields: true,
        },
        authentication: { status: 'available' },
      })
    );
    expect(legacy.toolkits[0]).toEqual({
      slug: 'gmail',
      displayName: 'Gmail',
      authKind: 'api-key',
      authentication: { status: 'available' },
    });
  });

  it('uplifts only declared OAuth2 and keeps an unknown configured override generic', async () => {
    const customOauth: ConnectorToolkit = {
      slug: 'calendar',
      displayName: 'Calendar',
      authKind: 'none',
      authenticationSetup: {
        kind: 'unsupported',
        source: 'unsupported',
        scheme: 'OAUTH2',
        requiresAccountFields: false,
      },
    };
    const unknown: ConnectorToolkit = {
      slug: 'unknown',
      displayName: 'Unknown',
      authKind: 'none',
      authenticationSetup: {
        kind: 'unsupported',
        source: 'unsupported',
        scheme: 'DCR',
        requiresAccountFields: false,
      },
    };
    const page = await listManagedConnectorCatalog({
      includeAuthenticationSetup: true,
      operations: operationsFor([customOauth, unknown]),
      config: {
        ...readyConfig,
        authConfigByToolkit: { calendar: 'configured-oauth', unknown: 'configured-unknown' },
      },
      rawRequest: { version: 1, limit: 20 },
      signal: AbortSignal.timeout(1_000),
    });

    expect(page.toolkits[0]).toEqual(
      expect.objectContaining({
        authKind: 'oauth2',
        authenticationSetup: {
          kind: 'oauth',
          source: 'configured',
          scheme: 'OAUTH2',
          requiresAccountFields: false,
        },
        authentication: { status: 'available' },
      })
    );
    expect(page.toolkits[1]).toEqual(
      expect.objectContaining({
        authKind: 'none',
        authenticationSetup: {
          kind: 'unsupported',
          source: 'configured',
          scheme: 'DCR',
          requiresAccountFields: false,
        },
        authentication: { status: 'available' },
      })
    );
  });
});

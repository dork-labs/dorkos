import { describe, expect, it } from 'vitest';

import {
  ManagedConnectorAccountListResponseSchema,
  ManagedConnectorAuthenticationStateSchema,
  ManagedConnectorCatalogPageSchema,
  ManagedConnectorCatalogRequestSchema,
  ManagedConnectorOperationPageResponseSchema,
} from '../connector-managed-discovery-schemas.js';

describe('managed connector discovery wire', () => {
  it('bounds catalog requests and rejects caller-selected authority', () => {
    expect(
      ManagedConnectorCatalogRequestSchema.parse({
        version: 1,
        query: 'mail',
        cursor: 'next',
        limit: 100,
      })
    ).toMatchObject({ query: 'mail', limit: 100 });
    expect(
      ManagedConnectorCatalogRequestSchema.safeParse({
        version: 1,
        limit: 101,
        tenantId: 'caller-choice',
      }).success
    ).toBe(false);
    expect(
      ManagedConnectorCatalogPageSchema.safeParse({
        version: 1,
        toolkits: [],
        truncated: false,
        providerUserId: 'private',
      }).success
    ).toBe(false);
    expect(
      ManagedConnectorCatalogPageSchema.parse({
        version: 1,
        toolkits: [
          {
            slug: 'notion',
            displayName: 'Notion',
            authKind: 'oauth2',
            authentication: {
              status: 'unsupported',
              reason: 'Managed account sign-in is not available for this service yet.',
            },
          },
        ],
        truncated: false,
      })
    ).toMatchObject({
      toolkits: [{ slug: 'notion', authentication: { status: 'unsupported' } }],
    });
  });

  it('keeps immutable operations finite, exact, and free of provider account fields', () => {
    const operation = {
      providerInstanceId: 'managed:composio',
      toolkit: 'gmail',
      hostedRevisionId: '11111111-1111-4111-8111-111111111111',
      operationSlug: 'gmail.messages.list',
      toolkitVersion: '20260901_00',
      schemaHash: 'sha256:schema',
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: { type: 'object', maximum: 10 },
    };
    const { hostedRevisionId: _hostedRevisionId, ...legacyOperation } = operation;
    expect(
      ManagedConnectorOperationPageResponseSchema.safeParse({
        version: 1,
        status: 'ok',
        operations: [legacyOperation],
        truncated: false,
      }).success
    ).toBe(false);
    expect(
      ManagedConnectorOperationPageResponseSchema.parse({
        version: 1,
        status: 'ok',
        operations: [operation],
        truncated: false,
      })
    ).toMatchObject({ operations: [operation] });
    expect(
      ManagedConnectorOperationPageResponseSchema.safeParse({
        version: 1,
        status: 'ok',
        operations: [{ ...operation, inputSchema: { maximum: Number.POSITIVE_INFINITY } }],
        truncated: false,
      }).success
    ).toBe(false);
    expect(
      ManagedConnectorOperationPageResponseSchema.safeParse({
        version: 1,
        status: 'ok',
        operations: [{ ...operation, externalAccountRef: 'ca_private' }],
        truncated: false,
      }).success
    ).toBe(false);
  });

  it('returns only site-owned account identity and retains tombstone state', () => {
    const account = {
      managedConnectionId: 'managed-1',
      toolkit: 'gmail',
      label: 'Personal Gmail',
      authenticationStatus: 'revoked',
      lifecycle: 'disconnected',
      bindingGeneration: 2,
      materialGeneration: 3,
    };
    expect(
      ManagedConnectorAccountListResponseSchema.parse({ version: 1, accounts: [account] })
    ).toEqual({ version: 1, accounts: [account] });
    for (const privateField of [
      'externalAccountRef',
      'providerUserId',
      'authConfigId',
      'providerUrl',
    ]) {
      expect(
        ManagedConnectorAccountListResponseSchema.safeParse({
          version: 1,
          accounts: [{ ...account, [privateField]: 'private' }],
        }).success
      ).toBe(false);
    }
  });

  it('keeps connected authentication state bound to a managed account', () => {
    expect(
      ManagedConnectorAuthenticationStateSchema.safeParse({
        version: 1,
        flowId: 'flow-1',
        toolkit: 'gmail',
        state: 'connected',
        connectionId: 'local-choice',
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      }).success
    ).toBe(false);
  });
});

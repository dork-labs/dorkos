import { describe, expect, it } from 'vitest';
import { CONNECTION_READINESS_COPY, ConnectionReadinessSchema } from '../connector-schemas.js';
import {
  ConnectorAuthoritySyncStateSchema,
  ConnectorAuthenticationFlowStateSchema,
  ConnectorCatalogLogoPathSchema,
  ConnectorCatalogResourcePageSchema,
  ConnectorConnectionDetailSchema,
  connectorCatalogLogoPath,
  ConnectorLifecycleResultSchema,
  ConnectorSessionConnectionsSchema,
} from '../connector-resource-schemas.js';

const capabilities = {
  catalog: { status: 'available' },
  authentication: { status: 'available' },
  accounts: { status: 'available' },
  operations: { status: 'available' },
  execution: { status: 'available' },
  triggers: { status: 'unsupported', reason: 'Events are not configured.' },
} as const;

describe('connector resource schemas', () => {
  it('keeps the account-free catalog route credential and provider-reference free', () => {
    const page = {
      services: [
        {
          serviceSlug: 'slack',
          displayName: 'Slack',
          iconKey: 'slack',
          intents: [
            {
              kind: 'messages',
              displayName: 'Messages through a Slack bot',
              relayAdapterType: 'slack',
            },
            {
              kind: 'account',
              displayName: 'Use a Slack account',
              routes: [
                {
                  providerInstanceId: 'local-composio',
                  displayName: 'Composio',
                  mode: 'byo',
                  custody: 'managed',
                  payer: 'operator_byo',
                  authKind: 'oauth2',
                  capabilities,
                  disclosure: 'Composio stores the connected account token.',
                },
              ],
            },
          ],
        },
      ],
      warnings: [],
    };
    expect(ConnectorCatalogResourcePageSchema.parse(page)).toEqual(page);
    expect(
      ConnectorCatalogResourcePageSchema.safeParse({
        ...page,
        services: [
          {
            ...page.services[0],
            intents: [
              {
                ...page.services[0]!.intents[1],
                externalAccountRef: 'private-account',
              },
            ],
          },
        ],
      }).success
    ).toBe(false);
  });

  it('makes an owner authentication flow durable and action-bound', () => {
    expect(
      ConnectorAuthenticationFlowStateSchema.parse({
        flowId: 'public-flow',
        providerInstanceId: 'local-composio',
        toolkit: 'gmail',
        state: 'pending',
        authorizeUrl: 'https://provider.example/authorize',
        createdAt: '2026-09-06T18:00:00.000Z',
        expiresAt: '2026-09-06T18:10:00.000Z',
      })
    ).toMatchObject({ state: 'pending' });
    expect(
      ConnectorAuthenticationFlowStateSchema.safeParse({
        flowId: 'public-flow',
        providerInstanceId: 'local-composio',
        toolkit: 'gmail',
        state: 'connected',
        authorizeUrl: 'https://provider.example/private-after-completion',
        connectionId: 'connection-1',
        createdAt: '2026-09-06T18:00:00.000Z',
        expiresAt: '2026-09-06T18:10:00.000Z',
        completedAt: '2026-09-06T18:02:00.000Z',
      }).success
    ).toBe(false);
  });

  it('keeps pending authority distinct from ready lifecycle state', () => {
    expect(
      ConnectorLifecycleResultSchema.parse({
        connectionId: 'connection-1',
        lifecycle: 'paused',
        authenticationStatus: 'active',
        authoritySync: { status: 'pending' },
        externalCleanup: 'not_required',
      })
    ).toMatchObject({ authoritySync: { status: 'pending' } });
  });

  it('models owner detail without account routing secrets', () => {
    const summary = {
      connectionId: 'connection-1',
      providerInstanceId: 'local-composio',
      toolkit: 'gmail',
      label: 'Work Gmail',
      identityHint: 'work@example.com',
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
      usage: { status: 'available', logicalOperationCount: 2, attemptCount: 3 },
      readiness: {
        state: 'needs_you',
        reason: 'signed_out',
        fix: { action: 'sign_in_again', fixableBy: 'person' },
        copy: { owner: 'Signed out.', agent: 'Ask the person to sign in again.' },
      },
    } as const;
    const detail = {
      connection: summary,
      provider: {
        providerInstanceId: 'local-composio',
        displayName: 'Composio',
        mode: 'byo',
        custody: 'managed',
        payer: 'operator_byo',
        capabilities,
        disclosure: 'Composio stores the connected account token.',
      },
      agents: [
        {
          agentId: 'agent-1',
          displayName: 'Researcher',
          operationRevisionIds: ['revision-1'],
          classifications: ['read'],
          reconciliationStatus: 'ready',
          authoritySync: { status: 'ready' },
        },
      ],
      sessions: { affectedCount: 1 },
      subscriptions: {
        totalCount: 0,
        activeCount: 0,
        capability: { status: 'unsupported', reason: 'Events are not configured.' },
      },
    };
    expect(ConnectorConnectionDetailSchema.parse(detail)).toEqual(detail);
    expect(
      ConnectorConnectionDetailSchema.safeParse({
        ...detail,
        externalAccountRef: 'private-account',
      }).success
    ).toBe(false);
  });

  it('carries each chat’s source and readiness, never a separate access verdict', () => {
    expect(
      ConnectorSessionConnectionsSchema.parse({
        sessionId: 'session-1',
        agentId: 'agent-1',
        connections: [
          {
            connectionId: 'connection-1',
            toolkit: 'gmail',
            label: 'Work Gmail',
            source: 'agent',
            operationRevisionIds: [],
            readiness: {
              state: 'paused',
              reason: 'paused',
              fix: { action: 'resume', fixableBy: 'person' },
              copy: CONNECTION_READINESS_COPY.paused,
            },
          },
        ],
      })
    ).toMatchObject({ sessionId: 'session-1' });
  });

  it('carries a pending reason only together with its retry time', () => {
    const retryAt = '2026-09-27T12:48:00.000Z';
    expect(ConnectorAuthoritySyncStateSchema.safeParse({ status: 'pending' }).success).toBe(true);
    expect(
      ConnectorAuthoritySyncStateSchema.safeParse({
        status: 'pending',
        reason: 'DorkOS’s servers had a problem.',
        retryAt,
      }).success
    ).toBe(true);
    expect(
      ConnectorAuthoritySyncStateSchema.safeParse({
        status: 'pending',
        reason: 'DorkOS’s servers had a problem.',
      }).success
    ).toBe(false);
    expect(
      ConnectorAuthoritySyncStateSchema.safeParse({ status: 'pending', retryAt }).success
    ).toBe(false);
  });
});

describe('connectorCatalogLogoPath', () => {
  it('names the server’s own logo route for a safe id, and nothing for any other', () => {
    expect(connectorCatalogLogoPath('googlecalendar')).toBe(
      '/api/connectors/catalog/logos/googlecalendar'
    );
    expect(connectorCatalogLogoPath('google-mail_2')).toBe(
      '/api/connectors/catalog/logos/google-mail_2'
    );
    for (const unsafe of ['Odd.Slug', 'a/b', '../x', '', 'x'.repeat(101)]) {
      expect(connectorCatalogLogoPath(unsafe), unsafe).toBeUndefined();
    }
  });

  it('only ever produces a path the wire schema accepts', () => {
    const path = connectorCatalogLogoPath('x'.repeat(100))!;
    expect(ConnectorCatalogLogoPathSchema.safeParse(path).success).toBe(true);
    expect(
      ConnectorCatalogLogoPathSchema.safeParse('https://logos.composio.dev/api/gmail').success
    ).toBe(false);
  });

  it('keeps readiness honest: only a usable account is ready, with nothing to fix, and waiting is DorkOS’s job', () => {
    const copy = { owner: 'Line.', agent: 'Agent line.' };
    expect(
      ConnectionReadinessSchema.safeParse({ state: 'ready', reason: 'usable', copy }).success
    ).toBe(true);
    expect(
      ConnectionReadinessSchema.safeParse({ state: 'ready', reason: 'paused', copy }).success
    ).toBe(false);
    expect(
      ConnectionReadinessSchema.safeParse({
        state: 'ready',
        reason: 'usable',
        fix: { action: 'retry', fixableBy: 'dorkos' },
        copy,
      }).success
    ).toBe(false);
    expect(
      ConnectionReadinessSchema.safeParse({
        state: 'finishing',
        reason: 'access_updating',
        fix: { action: 'wait', fixableBy: 'person' },
        copy,
      }).success
    ).toBe(false);
    expect(
      ConnectionReadinessSchema.safeParse({ state: 'gone', reason: 'made_up', copy }).success
    ).toBe(false);
  });
});

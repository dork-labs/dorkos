import { describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  eq,
  agents,
  sessionConnectionOverrides,
} from '@dorkos/db';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  ConnectorOperatorQueryService,
  ConnectorOperatorQueryError,
} from '../../resources/operator-query-service.js';
import { ConnectorRegistry } from '../../registry.js';
import {
  OWNER,
  PROVIDER_ID,
  NOW,
  useOperatorQueryHarness,
  FOREIGN_OWNER,
} from './connector-operator-query-service.fixtures.js';

/** The app catalog and account cards, scoped to the verified owner. */
describe('ConnectorOperatorQueryService', () => {
  const h = useOperatorQueryHarness();

  it('omits removed account cards and refuses their owner detail without deleting history', async () => {
    h.db
      .update(connections)
      .set({ lifecycleState: 'disconnected', removedAt: NOW })
      .where(eq(connections.id, 'connection-a'))
      .run();
    expect(await h.service.listConnections(OWNER)).toEqual([]);
    await expect(h.service.getConnection(OWNER, 'connection-a')).rejects.toThrow(
      'Connection not found'
    );
    expect(h.db.select().from(connections).all()).toHaveLength(1);
    expect(h.db.select().from(connectionOperationGrants).all()).toHaveLength(1);
  });

  it('returns one account-free catalog with per-route authentication and message intents', async () => {
    const catalog = await h.service.catalog({ signal: new AbortController().signal });

    // The live Gmail route merges into the built-in Gmail row: one row, not two.
    expect(catalog.services.filter((entry) => entry.serviceSlug === 'gmail')).toHaveLength(1);
    expect(catalog.services.find((entry) => entry.serviceSlug === 'gmail')).toEqual(
      expect.objectContaining({
        popular: true,
        description: 'Read, search and send email.',
        signInName: 'Google',
        intents: [
          expect.objectContaining({ kind: 'messages' }),
          expect.objectContaining({
            kind: 'account',
            routes: [
              expect.objectContaining({ authKind: 'oauth2', providerInstanceId: PROVIDER_ID }),
            ],
          }),
        ],
      })
    );
    expect(catalog.services.find((entry) => entry.serviceSlug === 'linear')).toEqual(
      expect.objectContaining({
        intents: [
          expect.objectContaining({
            kind: 'account',
            routes: [
              expect.objectContaining({
                authKind: 'api-key',
                capabilities: expect.objectContaining({
                  authentication: {
                    status: 'unsupported',
                    reason: 'Managed account sign-in is not available for this service yet.',
                  },
                }),
              }),
            ],
          }),
        ],
      })
    );
    expect(JSON.stringify(catalog)).not.toContain('private-account-a');
  });

  it('always lists the popular apps, each needing a way set up before it can connect', async () => {
    const empty = new ConnectorOperatorQueryService({
      db: h.db,
      registry: new ConnectorRegistry({
        db: h.db,
        configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
      }),
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
      appConnections: async () => ({
        ways: [],
        newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
      }),
    });

    const gmail = await empty.catalog({ query: 'gmail', signal: new AbortController().signal });
    expect(gmail).toEqual({
      services: [
        {
          serviceSlug: 'gmail',
          displayName: 'Gmail',
          iconKey: 'gmail',
          description: 'Read, search and send email.',
          category: 'email',
          popular: true,
          signInName: 'Google',
          intents: [{ kind: 'account', displayName: 'Use a Gmail account', routes: [] }],
        },
      ],
      warnings: [],
      appConnections: { ways: [], newApps: { status: 'setup_needed', reason: 'nothing_set_up' } },
    });

    // A search for what an app does finds it by its one line.
    const pages = await empty.catalog({ query: 'pages and', signal: new AbortController().signal });
    expect(pages.services.map((entry) => entry.serviceSlug)).toEqual(['notion']);

    // A search by shelf finds the apps on it.
    const email = await empty.catalog({ query: 'email', signal: new AbortController().signal });
    expect(email.services.map((entry) => entry.serviceSlug)).toEqual(['gmail', 'outlook']);
    const outlook = email.services[1]?.intents[0];
    expect(outlook?.displayName).toBe('Use an Outlook account');

    // Chat apps are listed with nothing set up, and never as an account to sign in to.
    const all = await empty.catalog({ limit: 100, signal: new AbortController().signal });
    const telegram = all.services.find((entry) => entry.serviceSlug === 'telegram');
    expect(telegram?.intents).toEqual([
      {
        kind: 'messages',
        displayName: 'Messages through a Telegram bot',
        relayAdapterType: 'telegram',
      },
    ]);
    expect(all.services.find((entry) => entry.serviceSlug === 'webhook')?.category).toBe(
      'developer'
    );

    // An agent can still ask for an app no way reaches yet (DOR-2494): the
    // request's card runs the one-time step first. The reason travels with it.
    const directory = await empty.serviceDirectory(new AbortController().signal);
    expect(directory.services).toContainEqual({
      serviceSlug: 'gmail',
      displayName: 'Gmail',
      requestable: true,
      reached: false,
    });
    expect(directory.reachProblem).toBe('nothing_set_up');
    // A chat app still has no account to ask for.
    expect(directory.services).toContainEqual({
      serviceSlug: 'telegram',
      displayName: 'Telegram',
      requestable: false,
      unavailableBecause: 'messaging_only',
    });
  });

  it('finds an app by its service id as well as its name (DOR-2237)', async () => {
    // "zoho crm" does not contain "zohocrm": only the id can match. Fails if the search
    // reads display names alone, which is what an agent searching by id ran into.
    const ids = new ConnectorRegistry({
      db: h.db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    ids.register(
      new FakeConnectorProvider({
        instanceId: ConnectorProviderInstanceIdSchema.parse('provider-ids'),
        type: 'fake',
        custody: 'managed',
        toolkits: [{ slug: 'zohocrm', displayName: 'Zoho CRM', authKind: 'oauth2' }],
      }),
      'material-ids'
    );
    const byId = new ConnectorOperatorQueryService({
      db: h.db,
      registry: ids,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
    });

    const page = await byId.catalog({ query: 'zohocrm', signal: new AbortController().signal });
    expect(page.services.map((entry) => entry.serviceSlug)).toEqual(['zohocrm']);
  });

  it('gives each app a same-origin logo path and one line, never the service’s logo URL', async () => {
    const logoRegistry = new ConnectorRegistry({
      db: h.db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    logoRegistry.register(
      new FakeConnectorProvider({
        instanceId: ConnectorProviderInstanceIdSchema.parse('provider-logos'),
        type: 'fake',
        custody: 'managed',
        toolkits: [
          {
            slug: 'gmail',
            displayName: 'Gmail',
            authKind: 'oauth2',
            logoUrl: 'https://logos.composio.dev/api/gmail',
            description: 'Gmail is Google’s email service.',
          },
          {
            slug: 'zendesk',
            displayName: 'Zendesk',
            authKind: 'oauth2',
            logoUrl: 'https://logos.composio.dev/api/zendesk',
            description: 'Zendesk runs customer support tickets.',
          },
          // Only another app's kept logo can give this one a mark.
          { slug: 'freshdesk', displayName: 'Freshdesk', authKind: 'oauth2' },
          { slug: 'bare', displayName: 'Bare', authKind: 'oauth2' },
          // Not a safe path segment, so it can never get a logo path.
          {
            slug: 'Odd.Slug',
            displayName: 'Odd',
            authKind: 'oauth2',
            logoUrl: 'https://logos.composio.dev/api/odd',
          },
        ],
      }),
      'material-logos'
    );
    const logos = new ConnectorOperatorQueryService({
      db: h.db,
      registry: logoRegistry,
      sessions: { resolveSessionAgent: () => undefined },
      agentOwnership: { ownsAgent: () => false },
      keptLogos: () => Promise.resolve(new Set(['freshdesk'])),
    });
    const signal = new AbortController().signal;

    const page = await logos.catalog({ limit: 100, signal });
    const bySlug = new Map(page.services.map((entry) => [entry.serviceSlug, entry]));

    // Our own line wins for a built-in app; the logo is the server's own path.
    expect(bySlug.get('gmail')).toMatchObject({
      description: 'Read, search and send email.',
      logo: '/api/connectors/catalog/logos/gmail',
    });
    expect(bySlug.get('zendesk')).toMatchObject({
      description: 'Zendesk runs customer support tickets.',
      logo: '/api/connectors/catalog/logos/zendesk',
    });
    expect(bySlug.get('freshdesk')?.logo).toBe('/api/connectors/catalog/logos/freshdesk');
    expect(bySlug.get('bare')).not.toHaveProperty('logo');
    expect(bySlug.get('bare')).not.toHaveProperty('description');
    expect(bySlug.get('Odd.Slug')).not.toHaveProperty('logo');
    // A built-in app nothing sends a logo for has none either.
    expect(bySlug.get('notion')).not.toHaveProperty('logo');
    expect(JSON.stringify(page)).not.toContain('logos.composio.dev');
  });

  it('scopes connection detail and agent profiles to the verified owner', async () => {
    await expect(h.service.listConnections(OWNER)).resolves.toEqual([
      expect.objectContaining({
        connectionId: 'connection-a',
        agentCount: 1,
        usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
      }),
    ]);
    await expect(h.service.getConnection(OWNER, 'connection-a')).resolves.toMatchObject({
      agents: [{ agentId: 'agent-a', operationRevisionIds: ['revision-a'] }],
      provider: { providerInstanceId: PROVIDER_ID },
    });
    await expect(h.service.listConnections(FOREIGN_OWNER)).resolves.toEqual([]);
    await expect(h.service.getConnection(FOREIGN_OWNER, 'connection-a')).rejects.toThrow(
      ConnectorOperatorQueryError
    );
    await expect(h.service.agentConnections(FOREIGN_OWNER, 'agent-a')).rejects.toMatchObject({
      code: 'agent_not_found',
    });
  });

  it('says per chat whether its agent can use each account, from one readiness', async () => {
    h.db
      .insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        state: 'detached',
        updatedAt: NOW,
      })
      .run();
    await expect(h.service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [
        {
          connectionId: 'connection-a',
          source: 'this_chat',
          readiness: { state: 'unavailable', reason: 'off_for_this_chat' },
          thisChat: 'off',
        },
      ],
    });

    // Turned on with nothing of its own: nothing to use here, so it reads as
    // off, and the owner's switch (the agent holds it account-wide) is the fix.
    h.db
      .update(sessionConnectionOverrides)
      .set({ state: 'attached' })
      .where(eq(sessionConnectionOverrides.sessionId, 'session-a'))
      .run();
    const empty = (await h.service.sessionConnections(OWNER, 'session-a')).connections[0];
    expect(empty?.readiness).toMatchObject({
      reason: 'off_for_this_chat',
      fix: { action: 'turn_on_for_this_chat', fixableBy: 'person' },
    });
    expect(empty?.thisChat).toBe('off');

    // With its own grant, the account's own state shows through.
    h.db
      .insert(connectionOperationGrants)
      .values({
        id: 'session-grant-a',
        subjectType: 'session',
        subjectId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: NOW,
      })
      .run();
    h.db
      .update(connections)
      .set({ enabled: false })
      .where(eq(connections.id, 'connection-a'))
      .run();
    await expect(h.service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [{ readiness: { state: 'paused', reason: 'paused' } }],
    });

    // Another agent's override: this chat was handed to someone else.
    h.db.update(connections).set({ enabled: true }).where(eq(connections.id, 'connection-a')).run();
    h.db
      .update(sessionConnectionOverrides)
      .set({ agentId: 'agent-b' })
      .where(eq(sessionConnectionOverrides.sessionId, 'session-a'))
      .run();
    await expect(h.service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [{ readiness: { reason: 'off_for_this_chat' } }],
    });

    // No override: the agent's own access, ready.
    h.db.delete(sessionConnectionOverrides).run();
    await expect(h.service.sessionConnections(OWNER, 'session-a')).resolves.toMatchObject({
      connections: [
        { source: 'agent', readiness: { state: 'ready', reason: 'usable' }, thisChat: 'on' },
      ],
    });
  });
});

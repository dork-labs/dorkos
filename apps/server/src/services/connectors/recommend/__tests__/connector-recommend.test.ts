/** `connector_recommend`: intent mode, the exactly-one rule, and the caller-only `connected` flag. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { FakeConnectorProvider } from '@dorkos/test-utils';

import { connectorDomain, type ConnectorCapabilityDeps } from '../../connector-capabilities.js';
import { ConnectorOperatorQueryService } from '../../resources/operator-query-service.js';
import { ConnectorRegistry } from '../../registry.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import type { ConnectorAccessQueryService } from '../../execution/access-query-service.js';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../../core/capabilities/index.js';
import { CapabilityToolError } from '../../../core/capabilities/mcp-envelope.js';
import { CATALOG_TRUNCATED_WARNING } from '../connector-recommend.js';

const recommend = connectorDomain.capabilities.find((c) => c.id === 'connector.recommend')!;

const runtimePrincipal = () =>
  createServerPrincipal({
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install-a' },
    bindingId: 'binding-a',
    runtime: 'claude-code',
    canonicalSessionId: 'session-a',
    agentId: 'agent-a',
    agentPath: '/projects/a',
  });

type Listed = Awaited<ReturnType<ConnectorAccessQueryService['listRuntimeConnections']>>;

/** An access service that lists only what the test hands it, for the principal it was given. */
function accessListing(listed: Listed | Error) {
  const listRuntimeConnections = vi.fn(async (_principal: unknown) => {
    if (listed instanceof Error) throw listed;
    return listed;
  });
  return {
    access: { listRuntimeConnections } as unknown as ConnectorAccessQueryService,
    listRuntimeConnections,
  };
}

const gmailAccount: Listed = {
  connections: [
    {
      connectionId: 'conn_gmail',
      toolkit: 'gmail',
      label: 'Work mail',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
  ],
} as Listed;

describe('connector_recommend', () => {
  let connectorDeps: ConnectorCapabilityDeps;

  beforeEach(() => {
    const db = createDb(':memory:');
    runMigrations(db);
    const registry = new ConnectorRegistry({ db });
    registry.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
    const queries = new ConnectorOperatorQueryService({
      db,
      registry,
      sessions: {
        resolveSessionAgent: () => {
          throw new Error('Private session lookup');
        },
      },
      agentOwnership: {
        ownsAgent: () => {
          throw new Error('Private owner lookup');
        },
      },
    });
    connectorDeps = {
      registry,
      catalog: (input) => queries.catalog({ ...input, includeAuthenticationSetup: false }),
      relay: {
        getManifest: (type) =>
          type === 'slack'
            ? { displayName: 'Slack' }
            : type === 'telegram'
              ? { displayName: 'Telegram' }
              : undefined,
      },
    };
  });

  const invoke = (
    input: Record<string, unknown>,
    extra: Partial<CapabilityDeps> = {},
    context: Partial<CapabilityHandlerContext> = {}
  ) =>
    recommend.invoke(
      { logger: noopLogger, connectorDeps, ...extra } as CapabilityDeps,
      recommend.input.parse(input),
      context as CapabilityHandlerContext
    ) as Promise<Record<string, unknown>>;

  describe('exactly one of service or intent', () => {
    it.each([[{}], [{ service: 'gmail', intent: 'read my email' }]])(
      'refuses %j with a plain error',
      async (input) => {
        const refused = await invoke(input).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(CapabilityToolError);
        expect((refused as CapabilityToolError).payload).toMatchObject({
          code: 'INVALID_INPUT',
          error: expect.stringContaining('exactly one of service'),
        });
      }
    );
  });

  describe('intent mode', () => {
    it('turns "let the team know the deploy is done" into chat apps, each with its routes', async () => {
      const result = (await invoke({ intent: 'let the team know the deploy is done' })) as {
        services: Array<{ serviceSlug: string; recommendations: Array<{ kind: string }> }>;
      };
      const slack = result.services.find((s) => s.serviceSlug === 'slack');
      expect(result.services.map((s) => s.serviceSlug)).toEqual(['slack', 'telegram']);
      expect(slack?.recommendations.map((r) => r.kind)).toEqual(['relay-adapter', 'gateway']);
    });

    it('turns "summarise my inbox" into email apps', async () => {
      const result = (await invoke({ intent: 'summarise my inbox' })) as {
        services: Array<{ serviceSlug: string; category?: string }>;
      };
      expect(result.services.map((s) => s.serviceSlug)).toEqual(['gmail', 'outlook']);
      expect(result.services.every((s) => s.category === 'email')).toBe(true);
    });

    it('returns an empty list when nothing fits', async () => {
      expect(await invoke({ intent: 'water the plants on the balcony' })).toEqual({
        services: [],
        warnings: [],
      });
    });

    it('returns at most five services', async () => {
      const result = (await invoke({
        intent: 'tasks tickets issues docs notes files email calendar chat',
      })) as { services: unknown[] };
      expect(result.services).toHaveLength(5);
    });
  });

  describe('reads the whole catalog', () => {
    it('scores an app listed past the first pages of a long catalog', async () => {
      // 600 live apps after the built-in ones: Zendesk sits past the 500th service.
      const toolkits = Array.from({ length: 599 }, (_, index) => ({
        slug: `app_${String(index).padStart(3, '0')}`,
        displayName: `App ${String(index).padStart(3, '0')}`,
        authKind: 'oauth2' as const,
      }));
      toolkits.push({ slug: 'zendesk', displayName: 'Zendesk', authKind: 'oauth2' as const });
      connectorDeps.registry.register(
        new FakeConnectorProvider({ type: 'nango', custody: 'self-host', toolkits })
      );
      const pages = vi.spyOn(connectorDeps, 'catalog');

      const result = (await invoke({ intent: 'reply to the zendesk queue' })) as {
        services: Array<{ serviceSlug: string }>;
        warnings: unknown[];
      };

      expect(result.services.map((s) => s.serviceSlug)).toEqual(['zendesk']);
      expect(result.warnings).toEqual([]);
      expect(pages.mock.calls.length).toBeGreaterThan(4);
    });

    it('says so when the catalog is longer than one search reads', async () => {
      connectorDeps = {
        ...connectorDeps,
        catalog: async ({ cursor }) => ({
          services: [],
          warnings: [],
          nextCursor: String(Number(cursor ?? 0) + 100),
        }),
      };
      const result = (await invoke({ intent: 'summarise my inbox' })) as {
        services: unknown[];
        warnings: Array<{ message: string }>;
      };
      expect(result.services).toEqual([]);
      expect(result.warnings).toEqual([CATALOG_TRUNCATED_WARNING]);
    });
  });

  describe('service mode stays as it was', () => {
    it('returns only recommendations and warnings when no turn principal reached the call', async () => {
      const result = await invoke({ service: 'gmail' });
      expect(Object.keys(result).sort()).toEqual(['recommendations', 'warnings']);
    });
  });

  describe('connected comes from the caller’s own granted connections', () => {
    it('reads exactly the calling turn’s principal and marks what it holds', async () => {
      const { access, listRuntimeConnections } = accessListing(gmailAccount);
      const principal = runtimePrincipal();
      const extra = { connectorExecutionDeps: { access } } as Partial<CapabilityDeps>;

      const gmail = await invoke({ service: 'gmail' }, extra, { serverPrincipal: principal });
      const intent = (await invoke({ intent: 'summarise my inbox' }, extra, {
        serverPrincipal: principal,
      })) as { services: Array<{ serviceSlug: string; connected?: boolean }> };

      expect(gmail.connected).toBe(true);
      expect(intent.services.map((s) => s.serviceSlug)).toEqual(['gmail', 'outlook']);
      expect(intent.services[0]).toMatchObject({ serviceSlug: 'gmail', connected: true });
      // No route reaches Outlook here, so the flag stays unknown rather than false.
      expect(intent.services[1]).not.toHaveProperty('connected');
      expect(listRuntimeConnections).toHaveBeenCalledWith(principal);
      expect(listRuntimeConnections.mock.calls.every(([p]) => p === principal)).toBe(true);
    });

    it('says false only for an account app it can see none of', async () => {
      const { access } = accessListing({ connections: [] } as Listed);
      const result = await invoke(
        { service: 'gmail' },
        { connectorExecutionDeps: { access } } as Partial<CapabilityDeps>,
        { serverPrincipal: runtimePrincipal() }
      );
      expect(result.connected).toBe(false);
    });

    it('counts an account given but not usable right now as connected', async () => {
      const { access } = accessListing({
        connections: [],
        unavailable: [
          {
            connectionId: 'conn_gmail',
            toolkit: 'gmail',
            label: 'Work mail',
            reason: 'paused',
            note: 'The person paused this account.',
          },
        ],
      } as unknown as Listed);
      const result = await invoke(
        { service: 'gmail' },
        { connectorExecutionDeps: { access } } as Partial<CapabilityDeps>,
        { serverPrincipal: runtimePrincipal() }
      );
      expect(result.connected).toBe(true);
    });

    it('leaves connected out for an app that may be set up as a chat app instead', async () => {
      // Slack has a chat-app route and an account route; the bot set up under
      // Messaging is not in this view, so "no account" is not "not set up".
      const { access } = accessListing({ connections: [] } as Listed);
      const result = await invoke(
        { service: 'slack' },
        { connectorExecutionDeps: { access } } as Partial<CapabilityDeps>,
        { serverPrincipal: runtimePrincipal() }
      );
      expect(result.recommendations).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'relay-adapter' })])
      );
      expect(result).not.toHaveProperty('connected');
    });

    it('leaves connected out for a chat-only app, which has no account to have', async () => {
      const { access } = accessListing({ connections: [] } as Listed);
      const result = await invoke(
        { service: 'telegram' },
        { connectorExecutionDeps: { access } } as Partial<CapabilityDeps>,
        { serverPrincipal: runtimePrincipal() }
      );
      expect(result).not.toHaveProperty('connected');
    });

    it.each([
      ['no principal', {}],
      ['a principal that was not minted by the server', { serverPrincipal: { claims: {} } }],
      [
        'a non-runtime principal',
        {
          serverPrincipal: createServerPrincipal({
            kind: 'bridged',
            owner: { kind: 'local_install', installationId: 'install-a' },
            platform: 'slack',
            platformUserId: 'U1',
          }),
        },
      ],
    ])('is unknown, never false, with %s', async (_label, context) => {
      const { access, listRuntimeConnections } = accessListing({ connections: [] } as Listed);
      const result = await invoke(
        { service: 'gmail' },
        { connectorExecutionDeps: { access } } as Partial<CapabilityDeps>,
        context as Partial<CapabilityHandlerContext>
      );
      expect(result).not.toHaveProperty('connected');
      expect(listRuntimeConnections).not.toHaveBeenCalled();
    });

    it('is unknown, never false, when the read fails or the access service is missing', async () => {
      const { access } = accessListing(new Error('turn expired'));
      const failed = await invoke(
        { service: 'gmail' },
        { connectorExecutionDeps: { access } } as Partial<CapabilityDeps>,
        { serverPrincipal: runtimePrincipal() }
      );
      const missing = await invoke(
        { service: 'gmail' },
        {},
        { serverPrincipal: runtimePrincipal() }
      );
      const intent = (await invoke(
        { intent: 'summarise my inbox' },
        { connectorExecutionDeps: { access } } as Partial<CapabilityDeps>,
        { serverPrincipal: runtimePrincipal() }
      )) as { services: object[] };

      expect(failed).not.toHaveProperty('connected');
      expect(missing).not.toHaveProperty('connected');
      expect(intent.services.length).toBeGreaterThan(0);
      for (const service of intent.services) expect(service).not.toHaveProperty('connected');
    });
  });
});

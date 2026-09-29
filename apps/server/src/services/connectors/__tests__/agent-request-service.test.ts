import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connectorAgentRequests,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReviewRequests,
  connections,
  createDb,
  eq,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  ne,
  runMigrations,
  sessionConnectionOverrides,
  sessionMessageAcceptanceReceipts,
  type Db,
} from '@dorkos/db';
import type {
  ConnectionId,
  ConnectorAgentConnectionRequestInput,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorEventDefinition } from '@dorkos/shared/connector-event-schemas';
import type { ConnectorEventCapability } from '@dorkos/shared/connector-events';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import type { ConnectorEventGrantPort } from '../events/grant-port.js';
import { ConnectorEventGrantService } from '../events/grant-service.js';
import { ConnectorSubscriptionService } from '../events/subscription-service.js';
import { ConnectorSubscriptionStore } from '../events/subscription-store.js';
import {
  CONNECTOR_REQUEST_RATE_LIMIT,
  openAgentRequest,
  ConnectorAgentRequestService,
  ConnectorAgentRequestSourceAdapter,
  type ConnectorAgentRequestAuthorityPort,
} from '../agent-request-service.js';
import { createServerPrincipal, type ServerPrincipalProof } from '../principal/server-principal.js';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  ConnectorOperatorQueryService,
  type ConnectorServiceDirectory,
} from '../resources/operator-query-service.js';
import { ConnectorRegistry } from '../registry.js';
import { ComposioConnectorProvider } from '../providers/composio.js';
import { FetchComposioHttpClient } from '../providers/composio-client.js';
import { MessageQueueStore } from '../../session/message-queue-store.js';
import { PrivateSessionMessageAcceptanceService } from '../../session/private-messages/acceptance.js';

const OWNER = { kind: 'local_install', installationId: 'install-1' } as const;
const NOW = new Date('2026-09-07T12:00:00.000Z');
const CONNECTION_ID = 'connection-1' as ConnectionId;
const INPUT: ConnectorAgentConnectionRequestInput = {
  version: 1,
  serviceSlug: 'gmail',
  reason: 'Read new mail and prepare a summary',
  access: 'read',
  requestedEvents: [],
};
/** The same ask, for read and write. */
const READ_WRITE: ConnectorAgentConnectionRequestInput = { ...INPUT, access: 'read-write' };

function directory(services: ReadonlyArray<readonly [string, string]>): ConnectorServiceDirectory {
  return {
    services: services.map(([serviceSlug, displayName]) => ({
      serviceSlug,
      displayName,
      requestable: true,
      reached: true,
    })),
    warnings: [],
    routeTypes: ['composio'],
    reachProblem: 'app_not_reached',
  };
}

function principal(
  overrides: Partial<Extract<ServerPrincipalProof['claims'], { kind: 'runtime' }>> = {}
) {
  return createServerPrincipal({
    kind: 'runtime',
    owner: OWNER,
    bindingId: 'binding-1',
    runtime: 'claude-code',
    canonicalSessionId: 'session-1',
    agentId: 'agent-1',
    agentPath: '/agents/researcher',
    ...overrides,
  });
}

function seedConnection(
  db: Db,
  options: { mode?: 'byo' | 'managed'; ownerId?: string } = {}
): void {
  db.insert(connectorProviderInstances)
    .values({
      id: 'provider-1',
      type: 'test',
      mode: options.mode ?? 'byo',
      displayName: 'Test provider',
      custody: options.mode === 'managed' ? 'managed' : 'self-host',
      capabilityJson: '{}',
      executionConfigGeneration: 1,
      ownerKind: 'local_install',
      ownerId: options.ownerId ?? OWNER.installationId,
      status: 'available',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
  db.insert(connections)
    .values({
      id: 'connection-1',
      providerInstanceId: 'provider-1',
      externalAccountRef: 'private-account-ref',
      toolkit: 'gmail',
      label: 'Work mail',
      status: 'active',
      lifecycleState: 'connected',
      enabled: true,
      grantReconciliationStatus: 'ready',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
  for (const [id, operationSlug] of [
    ['revision-read', 'gmail.read'],
    ['revision-draft', 'gmail.draft'],
    ['revision-delete', 'gmail.delete'],
  ] as const) {
    db.insert(connectorOperationRevisions)
      .values({
        id,
        providerInstanceId: 'provider-1',
        toolkit: 'gmail',
        operationSlug,
        toolkitVersion: '1',
        schemaHash: `hash-${id}`,
        capabilityClassification: operationSlug.endsWith('delete')
          ? 'destructive'
          : operationSlug.endsWith('draft')
            ? 'write'
            : 'read',
        retryPolicy: 'never',
        providerRevisionRef: `hosted-${id}`,
        inputSchemaJson: '{}',
        discoveredAt: NOW.toISOString(),
      })
      .run();
  }
}

describe('ConnectorAgentRequestService', () => {
  let db: Db;
  let authorityLive: boolean;
  let authority: ConnectorAgentRequestAuthorityPort;
  let clock: Date;
  let id: number;
  let nudges: string[];

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    seedConnection(db);
    authorityLive = true;
    clock = NOW;
    id = 0;
    nudges = [];
    authority = {
      revalidateOrigin: vi.fn(async () => authorityLive),
      revalidateOriginSync: vi.fn(() => authorityLive),
      resolveAgent: vi.fn((_owner, agentId) =>
        agentId === 'agent-1' ? { id: agentId, displayName: 'Researcher' } : undefined
      ),
    };
  });

  function service(
    overrides: Partial<ConstructorParameters<typeof ConnectorAgentRequestService>[0]> = {}
  ): ConnectorAgentRequestService {
    return new ConnectorAgentRequestService({
      db,
      services: {
        serviceDirectory: vi.fn(async () =>
          directory([
            ['gmail', 'Gmail'],
            ['slack', 'Slack'],
          ])
        ),
      },
      runtimePrincipals: { revalidatePrincipal: vi.fn(async () => true) },
      authority,
      bootEpoch: 'boot-a',
      now: () => clock,
      createId: () => `id-${++id}`,
      createSecret: () => 'resume-secret',
      resume: {
        accept: vi.fn(),
        nudge: (sessionId) => nudges.push(sessionId),
      },
      ...overrides,
    });
  }

  /** Give the agent live grants the way the shared access card's save would. */
  function grantLive(revisionIds: string[], connectionId = 'connection-1'): void {
    for (const operationRevisionId of revisionIds) {
      db.insert(connectionOperationGrants)
        .values({
          id: `grant-${operationRevisionId}`,
          subjectType: 'agent',
          subjectId: 'agent-1',
          agentId: 'agent-1',
          connectionId,
          operationRevisionId,
          createdBy: 'local_install:install-1',
          createdAt: NOW.toISOString(),
        })
        .run();
    }
  }

  function realEventGrants(
    count: number,
    probes: {
      /** Whether the destination check at each call (0-based) passes. */
      authorize?: (call: number) => boolean;
      /** Throws to fail a trigger at the service for the given call (0-based) or update. */
      reconcileTrigger?: (call: number, eventType: string) => void;
    } = {}
  ) {
    let triggerCalls = 0;
    const store = new ConnectorSubscriptionStore(db);
    const definitions: ConnectorEventDefinition[] = Array.from({ length: count }, (_, index) => ({
      eventType: `gmail.event_${index}`,
      displayName: `Event ${index}`,
      toolkit: 'gmail',
      toolkitVersion: '1',
      definitionHash: `sha256:${index.toString(16).padStart(64, '0')}`,
      filterSchema: { type: 'object', additionalProperties: false },
      payloadSchema: { type: 'object' },
      deliveryMode: 'webhook',
      expectedCadenceSeconds: null,
    }));
    const discovered = store.discover(
      store.connection(OWNER, CONNECTION_ID),
      definitions,
      NOW.toISOString()
    );
    const events: ConnectorEventCapability = {
      listDefinitions: vi.fn<ConnectorEventCapability['listDefinitions']>(async () => ({
        status: 'ok',
        definitions,
      })),
      reconcileTrigger: vi.fn<ConnectorEventCapability['reconcileTrigger']>(async (input) => {
        probes.reconcileTrigger?.(triggerCalls++, input.definition.eventType);
        return {
          status: 'found' as const,
          trigger: {
            providerTriggerRef: `trigger-${input.definition.eventType}`,
            externalAccountRef: input.externalAccountRef,
            enabled: true,
          },
        };
      }),
      createTrigger: vi.fn<ConnectorEventCapability['createTrigger']>(async () => ({
        status: 'error' as const,
        code: 'PROVIDER_PRECHECK_FAILED' as const,
      })),
      setTriggerEnabled: vi.fn<ConnectorEventCapability['setTriggerEnabled']>(async () => ({
        status: 'ok',
      })),
      deleteTrigger: vi.fn<ConnectorEventCapability['deleteTrigger']>(async () => ({
        status: 'ok',
      })),
      verifyWebhook: vi.fn<ConnectorEventCapability['verifyWebhook']>(async () => ({
        status: 'rejected',
        code: 'not_used',
      })),
    };
    const providerRegistry = {
      resolveProviderInstance: () => ({ events }) as ConnectorProvider,
    };
    let authorizeCalls = 0;
    const destinations = {
      authorize: vi.fn(async () => probes.authorize?.(authorizeCalls++) ?? true),
    };
    const subscriptions = new ConnectorSubscriptionService(
      store,
      providerRegistry,
      destinations,
      () => NOW.toISOString()
    );
    return {
      store,
      subscriptions,
      grants: new ConnectorEventGrantService(
        store,
        subscriptions,
        destinations,
        { reconcile: vi.fn(async () => false), ready: vi.fn(() => false), stage: vi.fn() },
        () => NOW.toISOString()
      ),
      scopes: discovered.map((definition) => ({
        connectionId: CONNECTION_ID,
        definitionId: definition.id,
        filter: {},
        agentId: 'agent-1',
        destination: { kind: 'agent' as const, id: 'agent-1' },
      })),
    };
  }

  it('creates one typed request without returning private account inventory and reuses its intent', async () => {
    const requests = service();

    const first = await requests.create(principal(), INPUT);
    const repeated = await requests.create(principal(), INPUT);

    expect(repeated.requestId).toBe(first.requestId);
    expect(first).toEqual(
      expect.objectContaining({
        status: 'awaiting_owner',
        serviceSlug: 'gmail',
        access: 'read',
        note: expect.stringContaining("The person hasn't answered yet"),
      })
    );
    expect(JSON.stringify(first)).not.toContain('private-account-ref');
    expect(JSON.stringify(first)).not.toContain('Work mail');
    expect(db.select().from(connectorReviewRequests).all()).toHaveLength(1);
    expect(db.select().from(connectorAgentRequests).all()).toHaveLength(1);
  });

  describe('one open request per agent and app (DOR-2497)', () => {
    it('reuses the open request whatever the reason says', async () => {
      const onChanged = vi.fn();
      const requests = service({ onChanged });
      const first = await requests.create(principal(), INPUT);
      const reworded = await requests.create(principal(), {
        ...INPUT,
        reason: 'Actually, check for anything from the bank',
      });

      expect(reworded.requestId).toBe(first.requestId);
      expect(reworded.reason).toBe(INPUT.reason);
      expect(db.select().from(connectorAgentRequests).all()).toHaveLength(1);
      expect(onChanged).toHaveBeenCalledTimes(1);
    });

    it('raises the open request when the agent asks for more, and never lowers it', async () => {
      const onChanged = vi.fn();
      const requests = service({ onChanged });
      const first = await requests.create(principal(), INPUT);

      const raised = await requests.create(principal(), READ_WRITE);
      expect(raised).toMatchObject({ requestId: first.requestId, access: 'read-write' });
      expect(onChanged).toHaveBeenCalledTimes(2);

      const lowered = await requests.create(principal(), INPUT);
      expect(lowered).toMatchObject({ requestId: first.requestId, access: 'read-write' });
      expect(onChanged).toHaveBeenCalledTimes(2);
      const review = db.select().from(connectorReviewRequests).get()!;
      expect(JSON.parse(review.actionPayloadJson)).toMatchObject({ access: 'read-write' });
    });

    it('refuses the same app from another chat with where to answer it', async () => {
      const requests = service();
      await requests.create(principal(), INPUT);

      await expect(
        requests.create(principal({ canonicalSessionId: 'session-2' }), INPUT)
      ).rejects.toMatchObject({
        code: 'request_open_elsewhere',
        message: expect.stringContaining('You already asked for Gmail in another chat'),
      });
      expect(db.select().from(connectorAgentRequests).all()).toHaveLength(1);
    });

    it('tells an agent asking again from another chat that the first ask was allowed', async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      grantLive(['revision-read']);
      await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      });

      await expect(
        requests.create(principal({ canonicalSessionId: 'session-2' }), INPUT)
      ).rejects.toMatchObject({
        code: 'request_open_elsewhere',
        message: expect.stringContaining('already allowed you to read Gmail'),
      });
    });

    it('never promises another chat’s narrower ask covers what this chat needs', async () => {
      const requests = service();
      await requests.create(principal(), INPUT);
      const refusal = await requests
        .create(principal({ canonicalSessionId: 'session-2' }), READ_WRITE)
        .then(
          () => new Error('expected a refusal'),
          (error: Error) => error
        );
      expect(refusal).toMatchObject({ code: 'request_open_elsewhere' });
      expect(refusal.message).toContain('That request asks only to read Gmail.');
      expect(refusal.message).not.toContain('you can use Gmail in this chat too');
    });

    it('says an allowed Read in another chat does not cover changing things here', async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      grantLive(['revision-read']);
      await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      });
      await expect(
        requests.create(principal({ canonicalSessionId: 'session-2' }), READ_WRITE)
      ).rejects.toMatchObject({
        message: expect.stringContaining("That doesn't cover changing things there."),
      });
    });

    it('lets an overdue request go before checking what is open', async () => {
      const requests = service({ requestTtlMs: 1_000 });
      await requests.create(principal(), INPUT);
      clock = new Date(NOW.getTime() + 2_000);
      // No maintenance tick ran; another chat can still ask.
      await expect(
        requests.create(principal({ canonicalSessionId: 'session-2' }), INPUT)
      ).resolves.toMatchObject({ status: 'awaiting_owner' });
    });

    it('opens a new request once the last one is answered and delivered', async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      await requests.resolve(OWNER, created.requestId, { decision: 'denied' });
      await requests.waitForResolution(principal(), created.requestId);

      const again = await requests.create(principal(), INPUT);
      expect(again.requestId).not.toBe(created.requestId);
      expect(again.status).toBe('awaiting_owner');
    });

    it('caps new requests per agent with a refusal the agent can pass on', async () => {
      const apps = [
        'gmail',
        'slack',
        'notion',
        'linear',
        'github',
        'jira',
        'asana',
        'trello',
        'dropbox',
        'zoom',
        'figma',
      ] as const;
      expect(apps).toHaveLength(CONNECTOR_REQUEST_RATE_LIMIT + 1);
      const requests = service({
        services: {
          serviceDirectory: vi.fn(async () => directory(apps.map((app) => [app, app] as const))),
        },
      });
      for (const app of apps.slice(0, CONNECTOR_REQUEST_RATE_LIMIT)) {
        await requests.create(principal(), { ...INPUT, serviceSlug: app });
      }
      // Asking again for an app already asked for reuses it and never counts.
      await expect(requests.create(principal(), INPUT)).resolves.toMatchObject({
        serviceSlug: 'gmail',
      });

      clock = new Date(NOW.getTime() + 3 * 60_000);
      await expect(
        requests.create(principal(), { ...INPUT, serviceSlug: 'figma' })
      ).rejects.toMatchObject({
        code: 'request_rate_limited',
        message: expect.stringContaining('You can ask for figma in about 7 minutes.'),
      });
      // Another agent is not held back by this one.
      await expect(
        requests.create(principal({ agentId: 'agent-2' }), { ...INPUT, serviceSlug: 'figma' })
      ).resolves.toMatchObject({ status: 'awaiting_owner' });

      clock = new Date(NOW.getTime() + 11 * 60_000);
      await expect(
        requests.create(principal(), { ...INPUT, serviceSlug: 'figma' })
      ).resolves.toMatchObject({ status: 'awaiting_owner' });
    });
  });

  describe('a plain note on every status', () => {
    it('says what happens next for each way a request can end', async () => {
      const requests = service({ requestTtlMs: 1_000 });
      const denied = await requests.create(principal(), INPUT);
      await expect(
        requests.resolve(OWNER, denied.requestId, { decision: 'denied' })
      ).resolves.toMatchObject({
        status: 'denied',
        note: "The person said no to Gmail. Don't ask again unless they bring it up.",
      });

      const expired = await requests.create(principal(), { ...INPUT, serviceSlug: 'slack' });
      clock = new Date(NOW.getTime() + 2_000);
      await requests.reconcile();
      await expect(requests.getForRuntime(principal(), expired.requestId)).resolves.toMatchObject({
        status: 'expired',
        note: 'Nobody answered in time, so nothing changed. Ask again only if you still need Slack.',
      });
    });

    it('carries no ids, links or internal words in any note', async () => {
      const requests = service();
      const created = await requests.create(principal(), READ_WRITE);
      grantLive(['revision-read']);
      const granted = await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      });
      for (const note of [created.note, granted.note]) {
        expect(note).not.toMatch(/connection-1|revision-|id-\d|https?:|operation|revision|scope/i);
      }
    });
  });

  describe('a request for a service this installation cannot connect', () => {
    // Display names verified against docs.composio.dev/toolkits/<slug> on 2026-09-23.
    const COMPOSIO = [
      ['gmail', 'Gmail'],
      ['outlook', 'Outlook'],
      ['composio_search', 'Composio Search'],
      ['linear', 'Linear'],
    ] as const;

    function withDirectory(value: ConnectorServiceDirectory) {
      return service({ services: { serviceDirectory: vi.fn(async () => value) } });
    }

    async function refusal(
      requests: ConnectorAgentRequestService,
      serviceSlug: string,
      runtime: 'claude-code' | 'codex' | 'opencode' = 'claude-code'
    ) {
      const error: unknown = await requests
        .create(principal({ runtime }), { ...INPUT, serviceSlug })
        .then(
          () => undefined,
          (caught: unknown) => caught
        );
      expect(error).toMatchObject({ code: 'service_unavailable' });
      expect(db.select().from(connectorReviewRequests).all()).toEqual([]);
      return (error as Error).message;
    }

    // The in-app report: an agent guessed `composio-emails`, was told only that the
    // service "is not available", and fell back to installing a CLI in its shell.
    it('points a guessed name at the lookup tool without suggesting a service named after the route', async () => {
      const message = await refusal(withDirectory(directory(COMPOSIO)), 'composio-emails');

      expect(message).toContain('"composio-emails"');
      expect(message).toContain('mcp__dorkos__connector_list_toolkits');
      expect(message).not.toContain('Close matches');
      expect(message).not.toContain('composio_search');
    });

    it('suggests the real service a route-prefixed guess names', async () => {
      const message = await refusal(withDirectory(directory(COMPOSIO)), 'composio_gmail');

      expect(message).toContain('Close matches: gmail.');
    });

    it('matches a service whose id is inside the guessed name', async () => {
      const message = await refusal(withDirectory(directory(COMPOSIO)), 'gmail_inbox');

      expect(message).toContain('Close matches: gmail.');
    });

    it('ignores every registered route name, not only the ones it knows by heart', async () => {
      const message = await refusal(
        withDirectory({
          ...directory([
            ['acme_search', 'Acme Search'],
            ['gmail', 'Gmail'],
          ]),
          routeTypes: ['acme-connect'],
        }),
        'acme-mail'
      );

      expect(message).not.toContain('acme_search');
    });

    it('lists at most five close matches, shortest first', async () => {
      const message = await refusal(
        withDirectory(
          directory([
            ['google_sheets', 'Google Sheets'],
            ['google_drive', 'Google Drive'],
            ['googledocs', 'Google Docs'],
            ['google_calendar', 'Google Calendar'],
            ['google_meet', 'Google Meet'],
            ['google_tasks', 'Google Tasks'],
            ['google_maps', 'Google Maps'],
          ])
        ),
        'google'
      );

      expect(message).toContain(
        'Close matches: googledocs, google_maps, google_meet, google_drive, google_tasks.'
      );
    });

    it('names the lookup tool the way this runtime calls it', async () => {
      const requests = withDirectory(directory(COMPOSIO));
      expect(await refusal(requests, 'mailbox', 'opencode')).toContain(
        'dorkos_connector_list_toolkits'
      );
      expect(await refusal(requests, 'mailbox', 'codex')).toContain(
        'mcp__dorkos__connector_list_toolkits'
      );
    });

    it('accepts a service a linked account brings back, through the recovery the lookup runs', async () => {
      // The catalog side reads its own store; this suite's seeded rows describe a
      // provider that registry never registers.
      const catalogDb = createDb(':memory:');
      runMigrations(catalogDb);
      const registry = new ConnectorRegistry({
        db: catalogDb,
        configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
      });
      const managed = new FakeConnectorProvider({
        instanceId: ConnectorProviderInstanceIdSchema.parse('provider-managed'),
        type: 'dorkos-managed',
        toolkits: [{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }],
      });
      const recoverManagedProvider = vi.fn(async () => {
        if (!registry.resolveProviderInstance(managed.instanceId)) {
          registry.register(managed, 'material-managed');
        }
      });
      const requests = service({
        services: new ConnectorOperatorQueryService({
          db: catalogDb,
          registry,
          recoverManagedProvider,
          sessions: { resolveSessionAgent: () => undefined },
          agentOwnership: { ownsAgent: () => false },
        }),
      });

      await expect(requests.create(principal(), INPUT)).resolves.toMatchObject({
        status: 'awaiting_owner',
        serviceSlug: 'gmail',
      });
      expect(recoverManagedProvider).toHaveBeenCalledOnce();
    });

    it('ignores the Composio name even when only the DorkOS-account route is registered', async () => {
      const message = await refusal(
        withDirectory({ ...directory(COMPOSIO), routeTypes: ['dorkos-managed'] }),
        'composio-emails'
      );

      expect(message).not.toContain('Close matches');
      expect(message).not.toContain('composio_search');
    });

    // ~850 services, 100 per upstream page, like Composio's real catalog.
    function composioFetch(options: { delayMs?: number } = {}) {
      const services = Array.from({ length: 850 }, (_, index) =>
        index === 849
          ? { slug: 'gmail', name: 'Gmail', auth_schemes: ['OAUTH2'] }
          : { slug: `service_${index}`, name: `Service ${index}`, auth_schemes: ['OAUTH2'] }
      );
      const calls: string[] = [];
      const aborted: string[] = [];
      const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (options.delayMs) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, options.delayMs);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              aborted.push(url.pathname);
              reject(init.signal?.reason);
            });
          });
        }
        const offset = Number(url.searchParams.get('cursor') ?? '0');
        const next = offset + 100;
        return new Response(
          JSON.stringify({
            items: services.slice(offset, next),
            next_cursor: next < services.length ? String(next) : null,
          }),
          { status: 200 }
        );
      });
      const catalogDb = createDb(':memory:');
      runMigrations(catalogDb);
      const registry = new ConnectorRegistry({
        db: catalogDb,
        configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
      });
      registry.register(
        new ComposioConnectorProvider({
          instanceId: ConnectorProviderInstanceIdSchema.parse('provider-composio'),
          operationClient: null,
          client: new FetchComposioHttpClient({
            apiKey: 'ak-hermetic',
            userId: 'owner-a',
            baseUrl: 'https://composio.example',
            fetchImpl: fetchImpl as unknown as typeof fetch,
          }),
        }),
        'material-composio'
      );
      const queries = new ConnectorOperatorQueryService({
        db: catalogDb,
        registry,
        sessions: { resolveSessionAgent: () => undefined },
        agentOwnership: { ownsAgent: () => false },
      });
      return { calls, aborted, queries };
    }

    it('lists the catalog upstream once and answers later requests from the kept copy', async () => {
      const { calls, queries } = composioFetch();

      await expect(
        service({ services: queries }).create(principal(), INPUT)
      ).resolves.toMatchObject({ status: 'awaiting_owner', serviceSlug: 'gmail' });
      // 850 services at 100 a page is 9 upstream pages, read once.
      expect(calls).toHaveLength(9);

      await expect(
        service({ services: queries }).create(principal(), INPUT)
      ).resolves.toMatchObject({ status: 'awaiting_owner', serviceSlug: 'gmail' });
      expect(calls).toHaveLength(9);
    });

    it('holds its deadline while the shared listing finishes for the next request', async () => {
      const { calls, aborted, queries } = composioFetch({ delayMs: 200 });
      const started = Date.now();

      const message = await refusal(
        service({ services: queries, serviceDirectoryTimeoutMs: 50 }),
        'gmail'
      );

      expect(message).toContain('Try again');
      expect(Date.now() - started).toBeLessThan(1_000);
      // One agent giving up does not cancel the listing every reader shares:
      // it runs to the end under its own deadline and is kept, and the retries
      // meanwhile wait on that same listing instead of starting another.
      await vi.waitFor(
        () =>
          expect(
            service({ services: queries, serviceDirectoryTimeoutMs: 50 }).create(principal(), INPUT)
          ).resolves.toMatchObject({ status: 'awaiting_owner', serviceSlug: 'gmail' }),
        { timeout: 5_000, interval: 100 }
      );
      expect(aborted).toEqual([]);
      expect(calls).toHaveLength(9);
    });

    it('answers "try again" on time even when a route ignores the signal', async () => {
      const started = Date.now();
      const message = await refusal(
        service({
          serviceDirectoryTimeoutMs: 50,
          services: {
            serviceDirectory: vi.fn(
              () =>
                new Promise<ConnectorServiceDirectory>((resolve) => {
                  setTimeout(() => resolve(directory([['gmail', 'Gmail']])), 1_500);
                })
            ),
          },
        }),
        'gmail'
      );

      expect(message).toContain('Try again');
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('tells the agent who can fix it when an app beyond the popular ones cannot be checked yet', async () => {
      const message = await refusal(
        withDirectory({ ...directory([]), reachProblem: 'nothing_set_up' }),
        'acme'
      );

      expect(message).toContain('DorkOS is not set up to reach apps yet');
      expect(message).toContain('only the popular apps it lists can be requested now');
      expect(message).toContain('Connections');
      // The page's Accounts card that linked a DorkOS account is gone; the first
      // connect is where a way to reach apps gets set up.
      expect(message).not.toContain('Accounts');
      expect(message).toContain('the first app they connect also sets up how DorkOS reaches apps');
      expect(message).toContain('command-line tool in a shell does not give DorkOS access');
      expect(message).not.toContain('connector_list_toolkits');
    });

    it('does not call a service missing when part of the service list failed to load', async () => {
      const message = await refusal(
        withDirectory({
          ...directory([['linear', 'Linear']]),
          warnings: [{ code: 'catalog_provider_unavailable', message: 'Composio is down.' }],
        }),
        'gmail'
      );

      expect(message).toContain('could not load the full list of services');
      expect(message).toContain('Try again');
      expect(message).not.toContain('Composio is down');
    });

    it('reads nothing loaded plus a warning as a retry, not as nothing set up', async () => {
      const message = await refusal(
        withDirectory({
          ...directory([]),
          warnings: [{ code: 'catalog_provider_unavailable', message: 'Composio is down.' }],
        }),
        'gmail'
      );

      expect(message).toContain('Try again');
      expect(message).not.toContain('not set up to reach apps');
    });

    it.each([
      ['dorkos_account_unlinked', "isn't linked anymore", 'Settings › Access'],
      ['dorkos_account_unavailable', 'is linked but cannot reach apps', 'Try again later'],
      ['own_key_unavailable', "isn't set up or didn't answer", 'Settings › Connections'],
    ] as const)(
      'names the fix for a way that is set up but down (%s), not "connect an app"',
      async (reachProblem, why, fix) => {
        const message = await refusal(withDirectory({ ...directory([]), reachProblem }), 'acme');

        expect(message).toContain(why);
        expect(message).toContain(fix);
        expect(message).not.toContain('connect an app');
      }
    );

    it('treats a service list that ran out of time as a retry', async () => {
      const requests = service({
        serviceDirectoryTimeoutMs: 20,
        services: {
          serviceDirectory: vi.fn(
            (signal: AbortSignal) =>
              new Promise<ConnectorServiceDirectory>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason));
              })
          ),
        },
      });

      expect(await refusal(requests, 'gmail')).toContain('Try again');
    });

    it('sends a Messaging-only service to the person instead of back to the lookup tool', async () => {
      const message = await refusal(
        withDirectory({
          ...directory(COMPOSIO),
          services: [
            ...directory(COMPOSIO).services,
            {
              serviceSlug: 'telegram',
              displayName: 'Telegram',
              requestable: false,
              unavailableBecause: 'messaging_only',
            },
          ],
        }),
        'telegram'
      );

      expect(message).toContain('Telegram connects through Messaging');
      expect(message).not.toContain('connector_list_toolkits');
    });

    /** The real catalog read, with nothing set up to reach apps. */
    function bareDirectory(registry?: ConnectorRegistry) {
      const catalogDb = createDb(':memory:');
      runMigrations(catalogDb);
      return new ConnectorOperatorQueryService({
        db: catalogDb,
        registry:
          registry ??
          new ConnectorRegistry({
            db: catalogDb,
            configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
          }),
        relay: {
          getManifest: (type) => (type === 'telegram' ? { displayName: 'Telegram' } : undefined),
          getCatalog: () => [{ manifest: { type: 'telegram', displayName: 'Telegram' } }],
        },
        sessions: { resolveSessionAgent: () => undefined },
        agentOwnership: { ownsAgent: () => false },
      });
    }

    it('records a request for a popular app no way reaches yet, once, like any other (DOR-2494)', async () => {
      const requests = service({ services: bareDirectory() });

      const created = await requests.create(principal(), INPUT);
      expect(created).toMatchObject({ status: 'awaiting_owner', serviceSlug: 'gmail' });
      // The same ask again is the same request: no second card, no second row.
      const again = await requests.create(principal(), INPUT);
      expect(again.requestId).toBe(created.requestId);
      expect(db.select().from(connectorReviewRequests).all()).toHaveLength(1);
      // Nothing is granted by asking: the owner still decides.
      expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
    });

    it('still refuses a chat app and an app beyond the popular ones when nothing is set up', async () => {
      expect(await refusal(service({ services: bareDirectory() }), 'telegram')).toContain(
        'Telegram connects through Messaging'
      );
      expect(await refusal(service({ services: bareDirectory() }), 'acme-crm')).toContain(
        'DorkOS is not set up to reach apps yet'
      );
    });

    it('reads a failing way as a retry for an unlisted app, and still takes a popular one', async () => {
      const failingDb = createDb(':memory:');
      runMigrations(failingDb);
      const registry = new ConnectorRegistry({
        db: failingDb,
        configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
      });
      const failing = new FakeConnectorProvider({
        instanceId: ConnectorProviderInstanceIdSchema.parse('provider-failing'),
        type: 'composio',
      });
      Object.defineProperty(failing, 'listToolkitPage', {
        value: () => Promise.reject(new Error('Composio is down')),
      });
      registry.register(failing);

      const message = await refusal(service({ services: bareDirectory(registry) }), 'acme-crm');

      expect(message).toContain('Try again');
      expect(message).not.toContain('Messaging');

      // A chat-only app does not depend on the catalog: same outage, Messaging guidance.
      const telegram = await refusal(service({ services: bareDirectory(registry) }), 'telegram');
      expect(telegram).toContain('Telegram connects through Messaging');
      expect(telegram).not.toContain('Try again');
      // A popular app is requestable through the outage; its card offers the retry.
      await expect(
        service({ services: bareDirectory(registry) }).create(principal(), INPUT)
      ).resolves.toMatchObject({ status: 'awaiting_owner', serviceSlug: 'gmail' });
    });
  });

  it('rejects a 33rd event before claiming operation or event authority', async () => {
    const { grants, scopes } = realEventGrants(33);
    const requests = service({ eventGrants: grants, resume: undefined });
    const eventNames = Array.from({ length: 32 }, (_, index) => `gmail.event_${index}`);

    await expect(
      requests.create(principal(), { ...INPUT, requestedEvents: [...eventNames, 'gmail.event_32'] })
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(db.select().from(connectorReviewRequests).all()).toEqual([]);

    const created = await requests.create(principal(), { ...INPUT, requestedEvents: eventNames });
    grantLive(['revision-read']);
    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
        eventScopes: scopes,
      })
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    expect(
      db.$client.prepare('SELECT COUNT(*) AS count FROM connector_event_subscriptions').get()
    ).toEqual({ count: 0 });
    expect(
      db.$client.prepare('SELECT COUNT(*) AS count FROM connector_event_consent_commands').get()
    ).toEqual({ count: 0 });

    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
        eventScopes: scopes.slice(0, 32),
      })
    ).resolves.toMatchObject({ status: 'granted' });
    expect(db.select().from(connectionOperationGrants).all()).toHaveLength(1);
    expect(
      db.$client.prepare('SELECT COUNT(*) AS count FROM connector_event_subscriptions').get()
    ).toEqual({ count: 32 });
  });

  it('binds runtime status reads to the exact agent and session', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);

    await expect(
      requests.getForRuntime(principal({ canonicalSessionId: 'session-other' }), created.requestId)
    ).rejects.toMatchObject({ code: 'request_not_found' });
    await expect(
      requests.getForRuntime(principal({ agentId: 'agent-other' }), created.requestId)
    ).rejects.toMatchObject({ code: 'request_not_found' });
  });

  it('lets only the owner answer a request', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);
    grantLive(['revision-read']);

    await expect(
      requests.resolve({ kind: 'local_install', installationId: 'foreign' }, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      })
    ).rejects.toMatchObject({ code: 'request_not_found' });
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');

    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      })
    ).resolves.toMatchObject({ status: 'granted', connectionId: CONNECTION_ID });
  });

  describe('answering with the access the agent already holds', () => {
    it('resolves with exactly the live grants and writes none, even beyond what was asked', async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      // Read and write from the card: more than the two operations requested.
      grantLive(['revision-read', 'revision-draft', 'revision-delete']);
      const before = db.select().from(connectionOperationGrants).all();

      const resolved = await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      });

      expect(resolved).toMatchObject({
        status: 'granted',
        connectionId: CONNECTION_ID,
        grantedOperationRevisionIds: ['revision-delete', 'revision-draft', 'revision-read'],
      });
      expect(db.select().from(connectionOperationGrants).all()).toEqual(before);
      expect(
        db
          .select()
          .from(connectorReviewRequests)
          .where(eq(connectorReviewRequests.state, 'approved'))
          .all()
      ).toHaveLength(1);
    });

    it('refuses when the agent holds nothing on that account, and leaves the request pending', async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'selection_invalid' });
      expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    });

    it("does not count another agent's access as this agent's", async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      db.insert(connectionOperationGrants)
        .values({
          id: 'grant-other',
          subjectType: 'agent',
          subjectId: 'agent-2',
          agentId: 'agent-2',
          connectionId: 'connection-1',
          operationRevisionId: 'revision-read',
          createdBy: 'local_install:install-1',
          createdAt: NOW.toISOString(),
        })
        .run();

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'selection_invalid' });
    });

    it('refuses a foreign owner and an account of another service', async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      grantLive(['revision-read']);
      db.update(connections)
        .set({ toolkit: 'slack' })
        .where(eq(connections.id, 'connection-1'))
        .run();

      await expect(
        requests.resolve({ kind: 'local_install', installationId: 'foreign' }, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'request_not_found' });
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'selection_invalid' });
    });

    it('waits for a managed account to finish applying the agent’s access', async () => {
      db.update(connectorProviderInstances)
        .set({ mode: 'managed', custody: 'managed' })
        .where(eq(connectorProviderInstances.id, 'provider-1'))
        .run();
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'authority_sync_failed' });
      expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    });

    it('resumes the live held call with the granted result', async () => {
      const requests = service({ liveHoldMs: 5_000 });
      const created = await requests.create(principal(), INPUT);
      const held = requests.waitForResolution(principal(), created.requestId);
      await Promise.resolve();
      grantLive(['revision-read']);

      await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      });

      await expect(held).resolves.toMatchObject({
        status: 'granted',
        grantedOperationRevisionIds: ['revision-read'],
      });
    });

    /** Share the account with every agent, the way the page's "Every agent" save does. */
    function shareWithEveryAgent(revisionIds: string[]): void {
      for (const operationRevisionId of revisionIds) {
        db.insert(connectionOperationGrants)
          .values({
            id: `every-${operationRevisionId}`,
            subjectType: 'every_agent',
            subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
            agentId: null,
            connectionId: 'connection-1',
            operationRevisionId,
            createdBy: 'local_install:install-1',
            createdAt: NOW.toISOString(),
          })
          .run();
      }
    }

    it('counts an "Every agent" grant as this agent\'s access, as the execution check does', async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      shareWithEveryAgent(['revision-read']);
      const before = db.select().from(connectionOperationGrants).all();

      const resolved = await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      });

      expect(resolved).toMatchObject({
        status: 'granted',
        grantedOperationRevisionIds: ['revision-read'],
        notGranted: [],
      });
      expect(db.select().from(connectionOperationGrants).all()).toEqual(before);
    });

    it('counts "Every agent" on a managed account once hosted authority has applied it', async () => {
      db.update(connectorProviderInstances)
        .set({ mode: 'managed', custody: 'managed' })
        .where(eq(connectorProviderInstances.id, 'provider-1'))
        .run();
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      shareWithEveryAgent(['revision-read']);

      // Nothing hosted has applied yet: the answer waits (DOR-2439).
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'authority_sync_failed' });

      const stamp = NOW.toISOString();
      db.insert(connectorManagedAuthorityOutbox)
        .values({
          commandId: 'every-agent-v1',
          connectionId: 'connection-1',
          providerInstanceId: 'provider-1',
          executionConfigGeneration: 1,
          ownerKind: 'local_install',
          ownerId: 'install-1',
          managedConnectionId: 'private-account-ref',
          scopeKind: 'every_agent_grants',
          subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
          scopeVersion: 1,
          requestHash: 'hash',
          requestJson: '{}',
          state: 'applied',
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run();
      db.insert(connectorManagedAuthorityScopes)
        .values({
          managedConnectionId: 'private-account-ref',
          scopeKind: 'every_agent_grants',
          subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
          scopeVersion: 1,
          lastCommandId: 'every-agent-v1',
          lastCommandHash: 'hash',
          updatedAt: stamp,
        })
        .run();

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).resolves.toMatchObject({
        status: 'granted',
        grantedOperationRevisionIds: ['revision-read'],
      });
    });

    /** Scope this session's use of the account by hand, as Connections does. */
    function overrideSession(
      state: 'attached' | 'detached',
      options: { agentId?: string; needsReconciliation?: boolean } = {}
    ): void {
      db.insert(sessionConnectionOverrides)
        .values({
          sessionId: 'session-1',
          agentId: options.agentId ?? 'agent-1',
          connectionId: 'connection-1',
          state,
          needsReconciliation: options.needsReconciliation ?? false,
          updatedAt: NOW.toISOString(),
        })
        .run();
    }

    /** A grant this session holds on its own, used only under an `attached` override. */
    function grantSession(operationRevisionId: string): void {
      db.insert(connectionOperationGrants)
        .values({
          id: `session-grant-${operationRevisionId}`,
          subjectType: 'session',
          subjectId: 'session-1',
          agentId: 'agent-1',
          connectionId: 'connection-1',
          operationRevisionId,
          createdBy: 'local_install:install-1',
          createdAt: NOW.toISOString(),
        })
        .run();
    }

    it.each([
      ['detached', 'detached', {}],
      ["another agent's", 'attached', { agentId: 'agent-2' }],
      ['awaiting reconciliation', 'attached', { needsReconciliation: true }],
    ] as const)(
      'refuses when this chat has the account turned off (%s override), as execution would',
      async (_label, state, options) => {
        const requests = service();
        const created = await requests.create(principal(), INPUT);
        grantLive(['revision-read']);
        grantSession('revision-read');
        overrideSession(state, options);

        await expect(
          requests.resolve(OWNER, created.requestId, {
            decision: 'current_access',
            connectionId: CONNECTION_ID,
          })
        ).rejects.toMatchObject({ code: 'session_access_off' });
        expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
      }
    );

    it("never counts another chat's own grant under an attached override", async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      overrideSession('attached');
      db.insert(connectionOperationGrants)
        .values({
          id: 'other-session-grant',
          subjectType: 'session',
          subjectId: 'session-2',
          agentId: 'agent-1',
          connectionId: 'connection-1',
          operationRevisionId: 'revision-read',
          createdBy: 'local_install:install-1',
          createdAt: NOW.toISOString(),
        })
        .run();

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'selection_invalid' });
    });

    it("counts only the session's own grants under an attached override", async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      grantLive(['revision-read', 'revision-draft']);
      overrideSession('attached');

      // The agent's own grants do not reach a chat scoped by hand.
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'selection_invalid' });

      grantSession('revision-read');
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).resolves.toMatchObject({ grantedOperationRevisionIds: ['revision-read'] });
    });

    describe('the follow-up rechecks the recorded access before it starts', () => {
      /** Answer with read access, then stop at the moment before the follow-up is claimed. */
      async function answeredFollowUp() {
        const queue = new MessageQueueStore(db);
        const source = new ConnectorAgentRequestSourceAdapter(db, authority, 'boot-a');
        const acceptance = new PrivateSessionMessageAcceptanceService(
          db,
          queue,
          [source],
          'boot-a',
          () => clock
        );
        const requests = service({
          resume: {
            accept: (ref) => {
              acceptance.accept(ref);
            },
            nudge: (sessionId) => nudges.push(sessionId),
          },
        });
        const created = await requests.create(principal(), INPUT);
        grantLive(['revision-read']);
        await requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        });
        clock = new Date(NOW.getTime() + 11 * 60_000);
        await requests.reconcile();
        const receiptId = db.select().from(sessionMessageAcceptanceReceipts).get()!.id;
        const prepared = await acceptance.prepare(receiptId);
        return { claim: () => acceptance.claim(receiptId, prepared), prepared };
      }

      it('refuses when a granted revision was revoked since', async () => {
        const followUp = await answeredFollowUp();
        db.update(connectionOperationGrants)
          .set({ revokedAt: clock.toISOString() })
          .where(eq(connectionOperationGrants.operationRevisionId, 'revision-read'))
          .run();
        expect(() => followUp.claim()).toThrow(
          expect.objectContaining({ code: 'authority_expired' })
        );
      });

      it('refuses when the pinned revision was replaced by a newer one', async () => {
        const followUp = await answeredFollowUp();
        db.insert(connectorOperationRevisions)
          .values({
            id: 'revision-read-2',
            providerInstanceId: 'provider-1',
            toolkit: 'gmail',
            operationSlug: 'gmail.read',
            toolkitVersion: '2',
            schemaHash: 'hash-revision-read-2',
            capabilityClassification: 'read',
            retryPolicy: 'never',
            providerRevisionRef: 'hosted-revision-read-2',
            inputSchemaJson: '{}',
            discoveredAt: NOW.toISOString(),
          })
          .run();
        db.update(connectionOperationGrants)
          .set({ revokedAt: clock.toISOString() })
          .where(eq(connectionOperationGrants.operationRevisionId, 'revision-read'))
          .run();
        grantLive(['revision-read-2']);
        expect(() => followUp.claim()).toThrow(
          expect.objectContaining({ code: 'authority_expired' })
        );
      });

      it('goes ahead when access was only added since, and names only what was recorded', async () => {
        const followUp = await answeredFollowUp();
        grantLive(['revision-draft']);
        expect(followUp.claim().content).toContain('revision-read');
        expect(followUp.prepared.content).not.toContain('revision-draft');
      });

      it('refuses when this chat has since had the account turned off', async () => {
        const followUp = await answeredFollowUp();
        overrideSession('detached');
        expect(() => followUp.claim()).toThrow(
          expect.objectContaining({ code: 'authority_expired' })
        );
      });
    });

    it('counts only live grants: a revoked one is not access', async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      grantLive(['revision-read', 'revision-draft']);
      db.update(connectionOperationGrants)
        .set({ revokedAt: NOW.toISOString() })
        .where(eq(connectionOperationGrants.operationRevisionId, 'revision-draft'))
        .run();

      const resolved = await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      });
      expect(resolved).toMatchObject({ grantedOperationRevisionIds: ['revision-read'] });
      // The follow-up for the first answer went out, so a new ask opens a new request.
      db.update(connectorAgentRequests).set({ resumeState: 'resumed' }).run();

      // Every grant revoked: nothing live, so nothing to answer with.
      const second = await requests.create(principal(), { ...INPUT, reason: 'Another look' });
      expect(second.requestId).not.toBe(created.requestId);
      db.update(connectionOperationGrants)
        .set({ revokedAt: NOW.toISOString() })
        .where(eq(connectionOperationGrants.operationRevisionId, 'revision-read'))
        .run();
      await expect(
        requests.resolve(OWNER, second.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'selection_invalid' });
    });

    it('tells the agent, by class, what it asked for and was not given', async () => {
      const queue = new MessageQueueStore(db);
      const source = new ConnectorAgentRequestSourceAdapter(db, authority, 'boot-a');
      const acceptance = new PrivateSessionMessageAcceptanceService(
        db,
        queue,
        [source],
        'boot-a',
        () => clock
      );
      const requests = service({
        resume: {
          accept: (ref) => {
            acceptance.accept(ref);
          },
          nudge: (sessionId) => nudges.push(sessionId),
        },
      });
      const created = await requests.create(principal(), READ_WRITE);
      // Asked to read and change things; the owner allowed Read.
      grantLive(['revision-read']);

      const resolved = await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      });
      expect(resolved).toMatchObject({
        notGranted: ['write'],
        note: expect.stringContaining("didn't allow you to change anything in Gmail"),
      });

      // No live call is holding it any more, so the answer rides a follow-up.
      clock = new Date(NOW.getTime() + 11 * 60_000);
      await requests.reconcile();
      const content = (
        await acceptance.prepare(db.select().from(sessionMessageAcceptanceReceipts).get()!.id)
      ).content;
      expect(content).toContain('You can now read Gmail.');
      expect(content).toContain("didn't allow you to change anything in Gmail");
      expect(content).not.toContain('Carry on');
    });

    it('never refuses what the level the agent asked for covers, whatever the action names', async () => {
      const requests = service();
      const created = await requests.create(principal(), READ_WRITE);
      // Read and write from the card: every read and write action there is.
      grantLive(['revision-read', 'revision-draft']);
      const resolved = await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      });
      expect(resolved).toMatchObject({
        notGranted: [],
        note: 'You can now read and change things in Gmail. Carry on with what you were doing.',
      });
    });

    it('does not report a class the account has no action of as refused', async () => {
      // A second route to Gmail whose only action reads.
      db.insert(connectorProviderInstances)
        .values({
          id: 'provider-2',
          type: 'test',
          mode: 'byo',
          displayName: 'Read-only provider',
          custody: 'self-host',
          capabilityJson: '{}',
          executionConfigGeneration: 1,
          ownerKind: 'local_install',
          ownerId: OWNER.installationId,
          status: 'available',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        })
        .run();
      db.insert(connections)
        .values({
          id: 'connection-2',
          providerInstanceId: 'provider-2',
          externalAccountRef: 'other-account-ref',
          toolkit: 'gmail',
          label: 'Home mail',
          status: 'active',
          lifecycleState: 'connected',
          enabled: true,
          grantReconciliationStatus: 'ready',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        })
        .run();
      db.insert(connectorOperationRevisions)
        .values({
          id: 'revision-read-2',
          providerInstanceId: 'provider-2',
          toolkit: 'gmail',
          operationSlug: 'gmail.read',
          toolkitVersion: '1',
          schemaHash: 'hash-read-2',
          capabilityClassification: 'read',
          retryPolicy: 'never',
          providerRevisionRef: 'hosted-read-2',
          inputSchemaJson: '{}',
          discoveredAt: NOW.toISOString(),
        })
        .run();
      const requests = service();
      const created = await requests.create(principal(), READ_WRITE);
      grantLive(['revision-read-2'], 'connection-2');
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: 'connection-2' as ConnectionId,
        })
      ).resolves.toMatchObject({ notGranted: [], note: expect.stringContaining('Carry on') });
    });

    it('treats a retry for another account as a different answer', async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      grantLive(['revision-read']);
      await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      });

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: 'connection-other' as ConnectionId,
        })
      ).rejects.toMatchObject({ code: 'request_already_resolved' });
    });

    it('answers the same decision twice idempotently and refuses a different later one', async () => {
      const requests = service();
      const created = await requests.create(principal(), INPUT);
      grantLive(['revision-read']);
      const decision = { decision: 'current_access', connectionId: CONNECTION_ID } as const;

      await requests.resolve(OWNER, created.requestId, decision);
      await expect(requests.resolve(OWNER, created.requestId, decision)).resolves.toMatchObject({
        status: 'granted',
      });
      await expect(
        requests.resolve(OWNER, created.requestId, { decision: 'denied' })
      ).rejects.toMatchObject({ code: 'request_already_resolved' });
    });
  });

  it('announces every change so open windows re-read their request lists', async () => {
    const onChanged = vi.fn();
    const requests = service({ onChanged });

    const created = await requests.create(principal(), INPUT);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Reusing the same unresolved intent is not a change.
    await requests.create(principal(), INPUT);
    expect(onChanged).toHaveBeenCalledTimes(1);

    await requests.resolve(OWNER, created.requestId, { decision: 'denied' });
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("names the room a request's turn belongs to, for the owner only", async () => {
    const requests = service({
      roomForSession: (sessionId) => (sessionId === 'session-1' ? 'room-1' : undefined),
    });
    const created = await requests.create(principal(), INPUT);

    expect(requests.getForOwner(OWNER, created.requestId)).toMatchObject({ roomId: 'room-1' });
    // The room is an owner-side fact; the agent's own status never carries it.
    expect(created).not.toHaveProperty('roomId');
  });

  it('never hands the agent a link into DorkOS', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);
    expect(JSON.stringify(created)).not.toMatch(/https?:\/\//);
    expect(created).not.toHaveProperty('openUrl');
  });

  it("lists only one conversation's requests when asked for its session", async () => {
    const requests = service();
    await requests.create(principal(), INPUT);
    await requests.create(principal({ canonicalSessionId: 'session-2' }), {
      ...INPUT,
      serviceSlug: 'slack',
      reason: 'Something else',
    });

    expect(requests.listForOwner(OWNER, undefined, 'session-2')).toMatchObject([
      { sessionId: 'session-2', reason: 'Something else' },
    ]);
    expect(requests.listForOwner(OWNER)).toHaveLength(2);
  });

  it('resumes a live held request with the real result and leaves no fallback claim', async () => {
    const requests = service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    const held = requests.waitForResolution(principal(), created.requestId);
    await Promise.resolve();

    grantLive(['revision-read']);
    await requests.resolve(OWNER, created.requestId, {
      decision: 'current_access',
      connectionId: CONNECTION_ID,
    });

    await expect(held).resolves.toMatchObject({
      status: 'granted',
      connectionId: 'connection-1',
    });
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null });
    expect(nudges).toContain('session-1');
  });

  it('returns a live denial through the exact hold before clearing its claim', async () => {
    const requests = service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    const held = requests.waitForResolution(principal(), created.requestId);
    await Promise.resolve();

    await requests.resolve(OWNER, created.requestId, {
      decision: 'denied',
    });

    await expect(held).resolves.toMatchObject({ status: 'denied' });
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null });
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
  });

  it('keeps a duplicate live hold attached when the first caller aborts', async () => {
    const requests = service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    const firstController = new AbortController();
    const first = requests.waitForResolution(
      principal(),
      created.requestId,
      firstController.signal
    );
    const second = requests.waitForResolution(principal(), created.requestId);
    await new Promise<void>((resolve) => setImmediate(resolve));

    firstController.abort();
    await expect(first).resolves.toMatchObject({ status: 'awaiting_owner' });
    await requests.resolve(OWNER, created.requestId, { decision: 'denied' });

    await expect(second).resolves.toMatchObject({ status: 'denied' });
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null });
  });

  it('returns one durable terminal result to both attached live waits', async () => {
    const requests = service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    const first = requests.waitForResolution(principal(), created.requestId);
    const second = requests.waitForResolution(principal(), created.requestId);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await requests.resolve(OWNER, created.requestId, { decision: 'denied' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'denied' }),
      expect.objectContaining({ status: 'denied' }),
    ]);
    expect(nudges).toEqual(['session-1']);
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null });
  });

  it('attaches to a terminal result resolved between create and live wait', async () => {
    const requests = service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    await requests.resolve(OWNER, created.requestId, { decision: 'denied' });

    await expect(requests.waitForResolution(principal(), created.requestId)).resolves.toMatchObject(
      {
        status: 'denied',
      }
    );
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null });
  });

  it('does not let awaiting-owner rows hide a cold terminal result', async () => {
    const accept = vi.fn();
    const requests = service({ resume: { accept, nudge: vi.fn() } });
    // One agent keeps one open request per app, so the page is filled by many agents.
    const created = await Promise.all(
      Array.from({ length: 26 }, (_, index) =>
        requests.create(principal({ agentId: `agent-${index}` }), INPUT)
      )
    );
    const terminalRequestId = created
      .map((item) => item.requestId)
      .sort()
      .at(-1)!;
    await requests.resolve(OWNER, terminalRequestId, { decision: 'denied' });

    await requests.reconcile();

    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'connector_agent_request', requestId: terminalRequestId })
    );
  });

  it('rotates a bounded reconciliation page past blocked granted requests', async () => {
    const accept = vi.fn();
    const requests = service({ resume: { accept, nudge: vi.fn() } });
    // One agent keeps one open request per app, so the page is filled by many agents.
    const created = await Promise.all(
      Array.from({ length: 26 }, (_, index) =>
        requests.create(principal({ agentId: `agent-${index}` }), INPUT)
      )
    );
    const terminalRequestId = created
      .map((item) => item.requestId)
      .sort()
      .at(-1)!;
    db.update(connectorAgentRequests)
      .set({ outcome: 'granted' })
      .where(ne(connectorAgentRequests.id, terminalRequestId))
      .run();
    await requests.resolve(OWNER, terminalRequestId, { decision: 'denied' });

    await requests.reconcile();
    expect(accept).not.toHaveBeenCalled();
    await requests.reconcile();

    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'connector_agent_request', requestId: terminalRequestId })
    );
  });

  it('expires through maintenance, writes no grant, and can produce one terminal follow-up', async () => {
    const queue = new MessageQueueStore(db);
    const source = new ConnectorAgentRequestSourceAdapter(db, authority, 'boot-b');
    const acceptance = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [source],
      'boot-b',
      () => clock
    );
    const requests = service({
      bootEpoch: 'boot-b',
      requestTtlMs: 1_000,
      resume: {
        accept: (ref) => {
          acceptance.accept(ref);
        },
        nudge: (sessionId) => nudges.push(sessionId),
      },
    });
    await requests.create(principal(), INPUT);
    clock = new Date(NOW.getTime() + 2_000);

    expect(await requests.reconcile()).toEqual({ expired: 1, accepted: 1, cancelled: 0 });
    expect(await requests.reconcile()).toEqual({ expired: 0, accepted: 0, cancelled: 0 });
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
    expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
    expect(
      await acceptance.prepare(db.select().from(sessionMessageAcceptanceReceipts).get()!.id)
    ).toMatchObject({ content: expect.stringContaining('Nobody answered in time') });
  });

  it('marks a removed origin terminal before any owner grant is written', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);
    authorityLive = false;

    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      })
    ).rejects.toMatchObject({ code: 'request_not_found' });
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ outcome: 'target_deleted', resumeState: 'ready' });
  });

  it('binds authentication to the exact owner request and derives its service and retry key', async () => {
    let savedFlow:
      | {
          flowId: string;
          providerInstanceId: string;
          toolkit: string;
          state: 'starting';
          createdAt: string;
          expiresAt: string;
        }
      | undefined;
    const authentication = {
      findByIdempotencyKey: vi.fn(() => savedFlow),
      start: vi.fn(async (_owner, input) => {
        savedFlow = {
          flowId: 'flow-1',
          providerInstanceId: input.providerInstanceId,
          toolkit: input.toolkit,
          state: 'starting',
          createdAt: NOW.toISOString(),
          expiresAt: '2026-09-07T12:15:00.000Z',
        };
        return savedFlow;
      }),
      poll: vi.fn(),
    };
    const requests = service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);

    const flow = await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
      label: 'Work mail',
    });

    expect(flow.flowId).toBe('flow-1');
    expect(authentication.start).toHaveBeenCalledWith(OWNER, {
      providerInstanceId: 'provider-1',
      toolkit: 'gmail',
      label: 'Work mail',
      idempotencyKey: `agent-request:${created.requestId}`,
    });
    expect(
      db
        .select({ providerInstanceId: connectorReviewRequests.providerInstanceId })
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, `id-2`))
        .get()
    ).toEqual({ providerInstanceId: 'provider-1' });

    await expect(
      requests.startAuthentication(OWNER, created.requestId, {
        providerInstanceId: 'provider-other' as never,
      })
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(authentication.start).toHaveBeenCalledTimes(1);
  });

  it('makes an associated authentication failure terminal without writing grants', async () => {
    const starting = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'starting' as const,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const failed = {
      ...starting,
      state: 'failed' as const,
      reason: 'Sign-in was not completed.',
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => starting),
      start: vi.fn(async () => starting),
      poll: vi.fn(async () => failed),
    };
    const requests = service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);
    await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
    });

    await expect(
      requests.pollAuthentication(OWNER, created.requestId, 'foreign-flow')
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(authentication.poll).not.toHaveBeenCalled();

    await expect(requests.pollAuthentication(OWNER, created.requestId, 'flow-1')).resolves.toEqual(
      failed
    );
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('authentication_failed');
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
    expect(nudges).toEqual([]);
  });

  it('does not materialize authentication state for a foreign owner read', async () => {
    const failed = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'failed' as const,
      reason: 'Sign-in was not completed.',
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => failed),
      start: vi.fn(),
      poll: vi.fn(),
    };
    const requests = service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);

    expect(() =>
      requests.getForOwner({ kind: 'local_install', installationId: 'foreign' }, created.requestId)
    ).toThrow(expect.objectContaining({ code: 'request_not_found' }));
    expect(authentication.findByIdempotencyKey).not.toHaveBeenCalled();
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get()
    ).toMatchObject({ outcome: null, resumeState: 'pending' });
  });

  it('keeps a connected authentication flow awaiting explicit owner grants', async () => {
    const starting = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'starting' as const,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const connected = {
      ...starting,
      state: 'connected' as const,
      connectionId: CONNECTION_ID,
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => starting),
      start: vi.fn(async () => starting),
      poll: vi.fn(async () => connected),
    };
    const requests = service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);
    await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
    });

    await expect(requests.pollAuthentication(OWNER, created.requestId, 'flow-1')).resolves.toEqual(
      connected
    );
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
  });

  it('refuses a provider poll result that no longer matches the durable request flow', async () => {
    const starting = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'starting' as const,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const mismatched = {
      ...starting,
      providerInstanceId: 'provider-other' as never,
      state: 'failed' as const,
      reason: 'Sign-in was not completed.',
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => starting),
      start: vi.fn(async () => starting),
      poll: vi.fn(async () => mismatched),
    };
    const requests = service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);
    await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
    });

    await expect(
      requests.pollAuthentication(OWNER, created.requestId, 'flow-1')
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
  });

  it('derives proposed event types from exact definitions and waits for the same review receipt', async () => {
    const eventInput = {
      ...INPUT,
      requestedEvents: ['gmail.message_received'],
    };
    let ready = false;
    const describe: ConnectorEventGrantPort['describe'] = (_owner, scopes) =>
      scopes.map((scope) => ({
        definitionId: scope.definitionId,
        eventType: 'gmail.message_received',
      }));
    const approve: ConnectorEventGrantPort['approve'] = async (_owner, review) => {
      const selections = review.scopes.map((scope) => ({
        subscriptionId: 'subscription-1',
        scopeVersion: 1,
        definitionId: scope.definitionId,
        eventScopeHash: 'a'.repeat(64),
      }));
      return ready
        ? { state: 'ready', selections, appliedEventScopeHash: 'b'.repeat(64) }
        : { state: 'pending', selections };
    };
    const eventGrants: ConnectorEventGrantPort = {
      describe: vi.fn(describe),
      approve: vi.fn(approve),
      ready: vi.fn(() => ready),
      withdraw: vi.fn(),
    };
    const requests = service({ eventGrants, resume: undefined });
    const created = await requests.create(principal(), eventInput);
    grantLive(['revision-read']);
    const eventScope = {
      connectionId: CONNECTION_ID,
      definitionId: 'definition-1',
      filter: {},
      agentId: 'agent-1',
      destination: { kind: 'agent' as const, id: 'agent-1' },
    };

    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
        eventScopes: [{ ...eventScope, agentId: 'agent-other' }],
      })
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(eventGrants.approve).not.toHaveBeenCalled();
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');

    const pending = await requests.resolve(OWNER, created.requestId, {
      decision: 'current_access',
      connectionId: CONNECTION_ID,
      eventScopes: [eventScope],
    });
    expect(pending).toMatchObject({
      status: 'access_pending',
      note: expect.stringContaining('still setting up your access to Gmail'),
    });
    expect(eventGrants.approve).toHaveBeenLastCalledWith(
      OWNER,
      expect.objectContaining({
        reviewId: expect.stringMatching(/^id-/),
        scopes: [eventScope],
      }),
      expect.any(AbortSignal)
    );

    ready = true;
    await expect(requests.reconcile()).resolves.toEqual({
      expired: 0,
      accepted: 0,
      cancelled: 0,
    });
    await expect(requests.getForRuntime(principal(), created.requestId)).resolves.toMatchObject({
      status: 'granted',
      grantedEvents: ['gmail.message_received'],
    });
    const stored = db
      .select()
      .from(connectorAgentRequests)
      .where(eq(connectorAgentRequests.id, created.requestId))
      .get();
    expect(JSON.parse(stored!.resolvedEventsJson!)).toEqual({
      appliedEventScopeHash: 'b'.repeat(64),
      selections: [
        {
          definitionId: 'definition-1',
          eventScopeHash: 'a'.repeat(64),
          scopeVersion: 1,
          subscriptionId: 'subscription-1',
        },
      ],
      version: 1,
    });
  });

  it('keeps a losing concurrent event decision free of authority side effects', async () => {
    let releaseFirstOrigin!: () => void;
    const firstOriginGate = new Promise<void>((resolve) => {
      releaseFirstOrigin = resolve;
    });
    let firstOriginEntered!: () => void;
    const firstOriginStarted = new Promise<void>((resolve) => {
      firstOriginEntered = resolve;
    });
    let originChecks = 0;
    vi.mocked(authority.revalidateOrigin).mockImplementation(async () => {
      originChecks += 1;
      if (originChecks === 1) {
        firstOriginEntered();
        await firstOriginGate;
      }
      return true;
    });
    let eventAuthorityWrites = 0;
    const eventScope = {
      connectionId: CONNECTION_ID,
      definitionId: 'definition-1',
      filter: {},
      agentId: 'agent-1',
      destination: { kind: 'agent' as const, id: 'agent-1' },
    };
    const eventGrants: ConnectorEventGrantPort = {
      describe: vi.fn<ConnectorEventGrantPort['describe']>((_owner, scopes) =>
        scopes.map((scope) => ({
          definitionId: scope.definitionId,
          eventType: 'gmail.message_received',
        }))
      ),
      approve: vi.fn(async () => {
        eventAuthorityWrites += 1;
        return {
          state: 'pending' as const,
          selections: [
            {
              subscriptionId: 'subscription-1',
              scopeVersion: 1,
              definitionId: eventScope.definitionId,
              eventScopeHash: 'a'.repeat(64),
            },
          ],
        };
      }),
      ready: vi.fn(() => false),
      withdraw: vi.fn(),
    };
    const requests = service({ eventGrants, resume: undefined });
    const created = await requests.create(principal(), {
      ...INPUT,
      requestedEvents: ['gmail.message_received'],
    });
    grantLive(['revision-read']);
    const eventDecision = requests.resolve(OWNER, created.requestId, {
      decision: 'current_access',
      connectionId: CONNECTION_ID,
      eventScopes: [eventScope],
    });
    await firstOriginStarted;

    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      })
    ).resolves.toMatchObject({ status: 'granted', grantedEvents: [] });
    releaseFirstOrigin();
    await expect(eventDecision).rejects.toMatchObject({ code: 'request_already_resolved' });

    expect(eventAuthorityWrites).toBe(0);
    expect(db.select().from(connectionOperationGrants).all()).toHaveLength(1);
    expect(requests.getForOwner(OWNER, created.requestId)).toMatchObject({
      status: 'granted',
      grantedEvents: [],
    });
  });

  it('keeps concurrent allow and decline consistent with the one winning answer', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);
    grantLive(['revision-read']);

    const outcomes = await Promise.allSettled([
      requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      }),
      requests.resolve(OWNER, created.requestId, { decision: 'denied' }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const final = requests.getForOwner(OWNER, created.requestId);
    expect(['denied', 'granted']).toContain(final.status);
    if (final.status === 'granted') {
      expect(final.grantedOperationRevisionIds).toEqual(['revision-read']);
    }
  });

  it('returns the same granted result to concurrent identical owner decisions', async () => {
    let releaseApprovals!: () => void;
    const approvalsReleased = new Promise<void>((resolve) => {
      releaseApprovals = resolve;
    });
    let approvalsEntered = 0;
    let releaseBothEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      releaseBothEntered = resolve;
    });
    const eventScope = {
      connectionId: CONNECTION_ID,
      definitionId: 'definition-1',
      filter: {},
      agentId: 'agent-1',
      destination: { kind: 'agent' as const, id: 'agent-1' },
    };
    const eventGrants: ConnectorEventGrantPort = {
      describe: vi.fn<ConnectorEventGrantPort['describe']>((_owner, scopes) =>
        scopes.map((scope) => ({
          definitionId: scope.definitionId,
          eventType: 'gmail.message_received',
        }))
      ),
      approve: vi.fn(async () => {
        approvalsEntered += 1;
        if (approvalsEntered === 2) releaseBothEntered();
        await approvalsReleased;
        return {
          state: 'ready' as const,
          selections: [
            {
              subscriptionId: 'subscription-1',
              scopeVersion: 1,
              definitionId: eventScope.definitionId,
              eventScopeHash: 'a'.repeat(64),
            },
          ],
          appliedEventScopeHash: 'b'.repeat(64),
        };
      }),
      ready: vi.fn(() => true),
      withdraw: vi.fn(),
    };
    const requests = service({ eventGrants, resume: undefined });
    const created = await requests.create(principal(), {
      ...INPUT,
      requestedEvents: ['gmail.message_received'],
    });
    grantLive(['revision-read']);
    const decision = {
      decision: 'current_access' as const,
      connectionId: CONNECTION_ID,
      eventScopes: [eventScope],
    };

    const first = requests.resolve(OWNER, created.requestId, decision);
    const second = requests.resolve(OWNER, created.requestId, decision);
    await bothEntered;
    releaseApprovals();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'granted' }),
      expect.objectContaining({ status: 'granted' }),
    ]);
    expect(eventGrants.approve).toHaveBeenCalledTimes(2);
    expect(db.select().from(connectionOperationGrants).all()).toHaveLength(1);
  });

  it('replays one denied decision idempotently and rejects a different later choice', async () => {
    const requests = service();
    const created = await requests.create(principal(), INPUT);

    await expect(
      requests.resolve(OWNER, created.requestId, { decision: 'denied' })
    ).resolves.toMatchObject({ status: 'denied' });
    await expect(
      requests.resolve(OWNER, created.requestId, { decision: 'denied' })
    ).resolves.toMatchObject({ status: 'denied' });
    await expect(
      requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
      })
    ).rejects.toMatchObject({ code: 'request_already_resolved' });
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
  });
  describe('updates that cannot be set up (fix round 1)', () => {
    const eventScope = {
      connectionId: CONNECTION_ID,
      definitionId: 'definition-1',
      filter: {},
      agentId: 'agent-1',
      destination: { kind: 'agent' as const, id: 'agent-1' },
    };

    function eventPort(state: () => 'ready' | 'pending' | 'unavailable'): ConnectorEventGrantPort {
      return {
        describe: vi.fn<ConnectorEventGrantPort['describe']>((_owner, scopes) =>
          scopes.map((scope) => ({
            definitionId: scope.definitionId,
            eventType: 'gmail.message_received',
          }))
        ),
        approve: vi.fn<ConnectorEventGrantPort['approve']>(async (_owner, review) => {
          const selections = review.scopes.map((scope) => ({
            subscriptionId: 'subscription-1',
            scopeVersion: 1,
            definitionId: scope.definitionId,
            eventScopeHash: 'a'.repeat(64),
          }));
          const now = state();
          if (now === 'ready') {
            return { state: 'ready', selections, appliedEventScopeHash: 'b'.repeat(64) };
          }
          return now === 'pending'
            ? { state: 'pending', selections }
            : { state: 'unavailable', selections: [] };
        }),
        ready: vi.fn(() => state() === 'ready'),
        withdraw: vi.fn(),
      };
    }

    it('takes the answer back when the updates are unavailable, so the person can still choose', async () => {
      const eventGrants = eventPort(() => 'unavailable');
      const requests = service({ eventGrants, resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.message_received'],
      });
      grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: [eventScope],
        })
      ).rejects.toMatchObject({ code: 'event_selection_unavailable' });
      expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');

      // The same answer again is tried again, not refused as already answered.
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: [eventScope],
        })
      ).rejects.toMatchObject({ code: 'event_selection_unavailable' });
      // Answering without updates works, and says so to the agent.
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).resolves.toMatchObject({
        status: 'granted',
        grantedEvents: [],
        note: expect.stringContaining("You won't get updates when something new happens in Gmail."),
      });
    });

    it('lets the person say no after updates failed', async () => {
      const requests = service({ eventGrants: eventPort(() => 'unavailable'), resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.message_received'],
      });
      grantLive(['revision-read']);
      await requests
        .resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: [eventScope],
        })
        .catch(() => undefined);
      await expect(
        requests.resolve(OWNER, created.requestId, { decision: 'denied' })
      ).resolves.toMatchObject({ status: 'denied' });
    });

    it('ends an answer whose updates never become live, and stops holding the app open', async () => {
      const requests = service({
        eventGrants: eventPort(() => 'pending'),
        resume: undefined,
        requestTtlMs: 60_000,
      });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.message_received'],
      });
      grantLive(['revision-read']);
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: [eventScope],
        })
      ).resolves.toMatchObject({ status: 'access_pending' });

      clock = new Date(NOW.getTime() + 61_000);
      await requests.reconcile();
      await expect(requests.getForRuntime(principal(), created.requestId)).resolves.toMatchObject({
        status: 'granted',
        grantedEvents: [],
        note: expect.stringContaining("You won't get updates"),
      });
      await requests.waitForResolution(principal(), created.requestId);
      // Delivered: the agent's other chats can ask for the app again.
      await expect(
        requests.create(principal({ canonicalSessionId: 'session-2' }), INPUT)
      ).resolves.toMatchObject({ status: 'awaiting_owner' });
    });

    it('does not count a past-due answer still waiting on updates as open', async () => {
      const requests = service({
        eventGrants: eventPort(() => 'pending'),
        resume: undefined,
        requestTtlMs: 60_000,
      });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.message_received'],
      });
      grantLive(['revision-read']);
      await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
        eventScopes: [eventScope],
      });
      clock = new Date(NOW.getTime() + 61_000);
      // No tick ran: create() ends it itself, then it is allowed and on its way.
      await expect(
        requests.create(principal({ canonicalSessionId: 'session-2' }), INPUT)
      ).rejects.toMatchObject({
        code: 'request_open_elsewhere',
        message: expect.stringContaining('already allowed you to read Gmail'),
      });
    });

    it('never raises a request once it has been answered', async () => {
      const onChanged = vi.fn();
      const requests = service({
        eventGrants: eventPort(() => 'pending'),
        resume: undefined,
        onChanged,
      });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.message_received'],
      });
      grantLive(['revision-read']);
      await requests.resolve(OWNER, created.requestId, {
        decision: 'current_access',
        connectionId: CONNECTION_ID,
        eventScopes: [eventScope],
      });
      const before = {
        request: db.select().from(connectorAgentRequests).get(),
        review: db.select().from(connectorReviewRequests).get(),
      };
      const calls = onChanged.mock.calls.length;

      await expect(
        requests.create(principal(), {
          ...READ_WRITE,
          requestedEvents: ['gmail.message_received', 'gmail.label_added'],
        })
      ).resolves.toMatchObject({ requestId: created.requestId, access: 'read' });
      expect(db.select().from(connectorAgentRequests).get()).toEqual(before.request);
      expect(db.select().from(connectorReviewRequests).get()).toEqual(before.review);
      expect(onChanged.mock.calls.length).toBe(calls);
    });
  });
  describe('taking back an answer stops its updates (fix round 2)', () => {
    const EVENTS = ['gmail.event_0', 'gmail.event_1'];

    function liveSubscriptions(): number {
      return (
        db.$client
          .prepare(
            'SELECT COUNT(*) AS count FROM connector_event_subscriptions WHERE enabled = 1 AND revoked_at IS NULL'
          )
          .get() as { count: number }
      ).count;
    }

    function consentCommands(): number {
      return (
        db.$client
          .prepare('SELECT COUNT(*) AS count FROM connector_event_consent_commands')
          .get() as { count: number }
      ).count;
    }

    it('stops the first update switched on when the second fails, so Not now means none arrive', async () => {
      // The trigger at the service fails for the second scope, after the first
      // was already switched on.
      const { grants, scopes } = realEventGrants(2, {
        reconcileTrigger: (call) => {
          if (call === 1) throw new Error('service dropped the second trigger');
        },
      });
      const requests = service({ eventGrants: grants, resume: undefined });
      const created = await requests.create(principal(), { ...INPUT, requestedEvents: EVENTS });
      grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: scopes,
        })
      ).rejects.toThrow('service dropped the second trigger');
      expect(liveSubscriptions()).toBe(0);
      expect(consentCommands()).toBe(0);
      expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');

      await expect(
        requests.resolve(OWNER, created.requestId, { decision: 'denied' })
      ).resolves.toMatchObject({ status: 'denied' });
      expect(liveSubscriptions()).toBe(0);
    });

    it('stops updates switched on before a refused destination, so "without updates" sends none', async () => {
      // One scope: the destination passes the two checks before switching it
      // on, and is refused at the final check after.
      const { grants, scopes } = realEventGrants(1, { authorize: (call) => call < 2 });
      const requests = service({ eventGrants: grants, resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.event_0'],
      });
      grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: scopes,
        })
      ).rejects.toMatchObject({ code: 'event_selection_unavailable' });
      expect(liveSubscriptions()).toBe(0);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).resolves.toMatchObject({ status: 'granted', grantedEvents: [] });
      expect(liveSubscriptions()).toBe(0);
      // A subscription the review made and then took back leaves the list too.
      expect(
        db.$client
          .prepare(
            'SELECT COUNT(*) AS count FROM connector_event_subscriptions WHERE removed_at IS NULL'
          )
          .get()
      ).toEqual({ count: 0 });
    });

    it('lets the person pick a different set after a failed pick', async () => {
      let refuse = true;
      const { grants, scopes } = realEventGrants(2, {
        // While refusing: the destination passes until the check after switching on.
        authorize: (call) => !refuse || call < 2,
      });
      const requests = service({ eventGrants: grants, resume: undefined });
      const created = await requests.create(principal(), { ...INPUT, requestedEvents: EVENTS });
      grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: [scopes[0]!],
        })
      ).rejects.toMatchObject({ code: 'event_selection_unavailable' });
      refuse = false;

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: [scopes[1]!],
        })
      ).resolves.toMatchObject({ status: 'granted', grantedEvents: ['gmail.event_1'] });
      expect(liveSubscriptions()).toBe(1);
    });

    it('takes the answer back when approving updates throws', async () => {
      const approve = vi.fn<ConnectorEventGrantPort['approve']>(async () => {
        throw new Error('event side crashed');
      });
      const withdraw = vi.fn<ConnectorEventGrantPort['withdraw']>();
      const requests = service({
        resume: undefined,
        eventGrants: {
          describe: (_owner, scopes) =>
            scopes.map((scope) => ({
              definitionId: scope.definitionId,
              eventType: 'gmail.event_0',
            })),
          approve,
          ready: () => false,
          withdraw,
        },
      });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.event_0'],
      });
      grantLive(['revision-read']);
      const scope = {
        connectionId: CONNECTION_ID,
        definitionId: 'definition-0',
        filter: {},
        agentId: 'agent-1',
        destination: { kind: 'agent' as const, id: 'agent-1' },
      };

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: [scope],
        })
      ).rejects.toThrow('event side crashed');
      expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
      expect(withdraw).toHaveBeenCalledWith(
        OWNER,
        expect.stringMatching(/^id-/),
        expect.any(String)
      );
      await expect(
        requests.resolve(OWNER, created.requestId, { decision: 'denied' })
      ).resolves.toMatchObject({ status: 'denied' });
    });

    it('never leaves a request answered on one side and unanswered on the other when answers race', async () => {
      // Two identical answers: the first's updates come back unavailable while
      // the second's come back ready after the first took the answer back.
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      let calls = 0;
      const withdraw = vi.fn<ConnectorEventGrantPort['withdraw']>();
      const eventGrants: ConnectorEventGrantPort = {
        describe: (_owner, scopes) =>
          scopes.map((scope) => ({ definitionId: scope.definitionId, eventType: 'gmail.event_0' })),
        approve: vi.fn<ConnectorEventGrantPort['approve']>(async (_owner, review) => {
          const call = calls++;
          const selections = review.scopes.map((scope) => ({
            subscriptionId: 'subscription-1',
            scopeVersion: 1,
            definitionId: scope.definitionId,
            eventScopeHash: 'a'.repeat(64),
          }));
          if (call === 0) return { state: 'unavailable', selections: [] };
          await secondGate;
          return { state: 'ready', selections, appliedEventScopeHash: 'b'.repeat(64) };
        }),
        ready: () => true,
        withdraw,
      };
      const requests = service({ eventGrants, resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.event_0'],
      });
      grantLive(['revision-read']);
      const decision = {
        decision: 'current_access' as const,
        connectionId: CONNECTION_ID,
        eventScopes: [
          {
            connectionId: CONNECTION_ID,
            definitionId: 'definition-0',
            filter: {},
            agentId: 'agent-1',
            destination: { kind: 'agent' as const, id: 'agent-1' },
          },
        ],
      };

      // Settled from the start, so the early refusal is never an unhandled rejection.
      const answers = Promise.allSettled([
        requests.resolve(OWNER, created.requestId, decision),
        requests.resolve(OWNER, created.requestId, decision),
      ]);
      // Let the unavailable one take the answer back before the other finishes.
      await expect.poll(() => withdraw.mock.calls.length).toBeGreaterThanOrEqual(1);
      releaseSecond();
      const settled = await answers;
      // Neither is passed off as a success over a request that reads as unanswered.
      for (const outcome of settled) {
        expect(outcome).toMatchObject({
          status: 'rejected',
          reason: expect.objectContaining({ code: 'event_selection_unavailable' }),
        });
      }

      const item = requests.getForOwner(OWNER, created.requestId);
      expect(item.status).toBe('awaiting_owner');
      const review = db.select().from(connectorReviewRequests).get()!;
      expect(review).toMatchObject({ state: 'pending', resolutionJson: null });
      // What the late approval switched on is stopped too.
      expect(withdraw.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('taking a pick back leaves the person’s own updates as they were (fix round 3)', () => {
    function subscriptionRow(id: string) {
      return db.$client
        .prepare(
          'SELECT scope_version, enabled, revoked_at, removed_at FROM connector_event_subscriptions WHERE id = ?'
        )
        .get(id) as {
        scope_version: number;
        enabled: number;
        revoked_at: string | null;
        removed_at: string | null;
      };
    }

    /** The person's own update, set up the way the page does: an owner review. */
    async function personUpdate(fixture: ReturnType<typeof realEventGrants>) {
      const result = await fixture.grants.approve(
        OWNER,
        { reviewId: 'person-page-review', scopes: [fixture.scopes[0]!] },
        new AbortController().signal
      );
      expect(result.state).toBe('ready');
      return { id: result.selections[0]!.subscriptionId };
    }

    async function failedPick(
      fixture: ReturnType<typeof realEventGrants>,
      eventScopes: typeof fixture.scopes
    ) {
      const requests = service({ eventGrants: fixture.grants, resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.event_0', 'gmail.event_1'],
      });
      grantLive(['revision-read']);
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes,
        })
      ).rejects.toThrow();
      await expect(
        requests.resolve(OWNER, created.requestId, { decision: 'denied' })
      ).resolves.toMatchObject({ status: 'denied' });
    }

    it('uses the person’s live update as it is, and it stays live after the pick fails', async () => {
      // The reviewer's probe: event_0 is live at v1; the agent's pick of both
      // updates fails after the review was prepared.
      let failSecond = false;
      const fixture = realEventGrants(2, {
        reconcileTrigger: (_call, eventType) => {
          if (failSecond && eventType === 'gmail.event_1') throw new Error('second trigger failed');
        },
      });
      const own = await personUpdate(fixture);
      const before = subscriptionRow(own.id);
      failSecond = true;

      await failedPick(fixture, fixture.scopes);

      expect(subscriptionRow(own.id)).toEqual(before);
      expect(fixture.store.active(own.id, before.scope_version)).toBeDefined();
    });

    it('counts the person’s live update as set up, without taking it over', async () => {
      const fixture = realEventGrants(1);
      // Set up on the page, so a review already selected it.
      const own = await personUpdate(fixture);
      const before = subscriptionRow(own.id);
      const requests = service({ eventGrants: fixture.grants, resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.event_0'],
      });
      grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: fixture.scopes,
        })
      ).resolves.toMatchObject({ status: 'granted', grantedEvents: ['gmail.event_0'] });
      expect(subscriptionRow(own.id)).toEqual(before);
    });

    it('puts back a taken-over update even when it had been stopped', async () => {
      const fixture = realEventGrants(1, { authorize: () => true });
      const signal = new AbortController().signal;
      const own = await fixture.subscriptions.create(OWNER, fixture.scopes[0]!, signal);
      fixture.store.revoke(OWNER, own.id, NOW.toISOString());
      const before = subscriptionRow(own.id);
      expect(before.revoked_at).not.toBeNull();

      await expect(
        fixture.grants.approve(OWNER, { reviewId: 'review-1', scopes: fixture.scopes }, signal)
      ).resolves.toMatchObject({ state: 'ready' });
      expect(subscriptionRow(own.id).revoked_at).toBeNull();
      fixture.grants.withdraw(OWNER, 'review-1', NOW.toISOString());

      // Stopped again, exactly as before: this account is not managed, so its
      // own generation comes back.
      expect(subscriptionRow(own.id)).toEqual(before);
    });

    it('gives a pending update back its own generation, so its recovery resumes it', async () => {
      let failFirst = true;
      const fixture = realEventGrants(1, {
        reconcileTrigger: () => {
          if (failFirst) throw new Error('the service did not answer');
        },
      });
      const signal = new AbortController().signal;
      // The person's update is still pending: its first switch-on failed.
      await expect(
        fixture.grants.approve(
          OWNER,
          { reviewId: 'person-page-review', scopes: fixture.scopes },
          signal
        )
      ).rejects.toThrow('the service did not answer');
      const own = db.$client.prepare('SELECT id FROM connector_event_subscriptions').get() as {
        id: string;
      };
      const before = subscriptionRow(own.id);
      expect(before).toMatchObject({ scope_version: 1, enabled: 0, revoked_at: null });
      failFirst = false;

      // An agent's pick takes it over (it is not live) and is then taken back.
      await expect(
        fixture.grants.approve(OWNER, { reviewId: 'review-1', scopes: fixture.scopes }, signal)
      ).resolves.toMatchObject({ state: 'ready' });
      expect(subscriptionRow(own.id).scope_version).toBe(2);
      fixture.grants.withdraw(OWNER, 'review-1', NOW.toISOString());
      expect(subscriptionRow(own.id)).toEqual(before);

      // The person's own review names that generation again, so recovery resumes it.
      await expect(fixture.grants.recoverPending(signal)).resolves.toEqual({
        examined: 1,
        ready: 1,
      });
      expect(subscriptionRow(own.id)).toMatchObject({ scope_version: 1, enabled: 1 });
      expect(fixture.store.active(own.id, 1)).toBeDefined();
    });

    it('never touches a generation the owner changed after the pick', async () => {
      const fixture = realEventGrants(1);
      const signal = new AbortController().signal;
      // An agent's pick switches a new update on.
      await expect(
        fixture.grants.approve(OWNER, { reviewId: 'review-1', scopes: fixture.scopes }, signal)
      ).resolves.toMatchObject({ state: 'ready' });
      const picked = db.$client
        .prepare('SELECT id, scope_version FROM connector_event_subscriptions')
        .get() as { id: string; scope_version: number };
      // The owner then sets the same update up again on the page: a new generation.
      await fixture.subscriptions.create(OWNER, fixture.scopes[0]!, signal);
      const edited = subscriptionRow(picked.id);
      expect(edited.scope_version).toBe(picked.scope_version + 1);

      fixture.grants.withdraw(OWNER, 'review-1', NOW.toISOString());

      expect(subscriptionRow(picked.id)).toEqual(edited);
      expect(fixture.store.active(picked.id, edited.scope_version)).toBeDefined();
    });

    it('never puts back a taken-over update the owner changed after the pick', async () => {
      const fixture = realEventGrants(1);
      const signal = new AbortController().signal;
      const own = await fixture.subscriptions.create(OWNER, fixture.scopes[0]!, signal);
      fixture.store.revoke(OWNER, own.id, NOW.toISOString());
      // The pick takes the stopped update over.
      await expect(
        fixture.grants.approve(OWNER, { reviewId: 'review-1', scopes: fixture.scopes }, signal)
      ).resolves.toMatchObject({ state: 'ready' });
      // The owner then sets it up again on the page: a newer generation.
      await fixture.subscriptions.create(OWNER, fixture.scopes[0]!, signal);
      const edited = subscriptionRow(own.id);

      fixture.grants.withdraw(OWNER, 'review-1', NOW.toISOString());

      expect(subscriptionRow(own.id)).toEqual(edited);
      expect(fixture.store.active(own.id, edited.scope_version)).toBeDefined();
    });
  });

  describe('the stored approval a set of updates is read from', () => {
    async function pageThenAgent() {
      const fixture = realEventGrants(2);
      const signal = new AbortController().signal;
      // Review ids chosen so the page's single-update review is read first.
      const page = await fixture.grants.approve(
        OWNER,
        { reviewId: 'a-page-review', scopes: [fixture.scopes[0]!] },
        signal
      );
      const agent = await fixture.grants.approve(
        OWNER,
        { reviewId: 'z-agent-review', scopes: fixture.scopes },
        signal
      );
      if (page.state !== 'ready' || agent.state !== 'ready') throw new Error('not ready');
      return { fixture, page, agent };
    }

    it('answers a set only from a review of exactly that set', async () => {
      const { fixture, page, agent } = await pageThenAgent();
      // The agent's pick used the page's live update as it is.
      expect(agent.selections).toContainEqual(page.selections[0]);

      const forAgent = fixture.store.approvedSelections(OWNER, agent.selections);
      expect(forAgent?.map((item) => item.selection)).toHaveLength(2);
      expect(fixture.grants.ready(OWNER, agent.selections, agent.appliedEventScopeHash)).toBe(true);
      // The page's review of one update never answers for the agent's two, and
      // the agent's review of two never answers for the page's one.
      expect(
        fixture.store.approvedSelections(OWNER, page.selections)?.map((item) => item.selection)
      ).toEqual(page.selections);
      expect(fixture.grants.ready(OWNER, page.selections, page.appliedEventScopeHash)).toBe(true);
    });

    it('never reads another owner’s stored approval', async () => {
      const { fixture, agent } = await pageThenAgent();
      // The agent's review, moved under another owner: nothing of this owner's
      // names that set any more.
      db.$client
        .prepare(
          "UPDATE connector_event_consent_commands SET owner_id = 'someone-else' WHERE review_id = 'z-agent-review'"
        )
        .run();
      expect(fixture.store.approvedSelections(OWNER, agent.selections)).toBeUndefined();
      expect(fixture.grants.ready(OWNER, agent.selections, agent.appliedEventScopeHash)).toBe(
        false
      );
    });
  });

  describe('which requests count as open', () => {
    it('does not count an unanswered request past its time, even before anything expires it', async () => {
      // `create()` expires overdue requests first; this reads the check alone.
      const requests = service({ requestTtlMs: 1_000 });
      const created = await requests.create(principal(), INPUT);
      const later = new Date(NOW.getTime() + 2_000).toISOString();
      expect(openAgentRequest(db, 'agent-1', 'gmail', NOW.toISOString())?.request.id).toBe(
        created.requestId
      );
      expect(openAgentRequest(db, 'agent-1', 'gmail', later)).toBeUndefined();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectorAuthenticationFlows,
  connections,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import type { ConnectPoll, ConnectStart } from '@dorkos/shared/connector-provider';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  ConnectorAuthenticationFlowError,
  ConnectorAuthenticationFlowService,
} from '../resources/authentication-flow-service.js';
import { ConnectorRegistry } from '../registry.js';
import { FetchComposioHttpClient } from '../providers/composio-client.js';
import { ComposioConnectorProvider } from '../providers/composio.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const FOREIGN_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;
const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');
const NOW = new Date('2026-09-06T18:00:00.000Z');

class RestartSafeProvider extends FakeConnectorProvider {
  /** Start a provider flow whose handle is independently pollable after restart. */
  override startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart> {
    return Promise.resolve({
      flowId: `provider-flow:${toolkit}:${opts?.label ?? 'default'}`,
      authorizeUrl: 'https://provider.example/authorize',
    });
  }

  /** Resolve solely from the provider-private handle, without process memory. */
  override pollConnect(flowId: string): Promise<ConnectPoll> {
    const [, toolkit, label] = flowId.split(':');
    return Promise.resolve({
      status: 'connected',
      account: {
        externalAccountRef: `external:${toolkit}:${label}` as never,
        toolkit: toolkit!,
        label: label!,
        status: 'active',
        custody: 'managed',
      },
    });
  }
}

function insertActiveConnection(db: Db, connectionId = 'connection-existing') {
  const id = ConnectionIdSchema.parse(connectionId);
  db.insert(connections)
    .values({
      id,
      providerInstanceId: PROVIDER_ID,
      externalAccountRef: 'external:gmail:Original',
      toolkit: 'gmail',
      label: 'Original',
      status: 'active',
      lifecycleState: 'connected',
      enabled: true,
      grantReconciliationStatus: 'ready',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
  return id;
}

describe('ConnectorAuthenticationFlowService', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: RestartSafeProvider;
  let service: ConnectorAuthenticationFlowService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    provider = new RestartSafeProvider({ instanceId: PROVIDER_ID });
    registry.register(provider, 'material-a');
    service = new ConnectorAuthenticationFlowService({ db, registry, now: () => NOW });
  });

  it('claims idempotency before provider create and returns the same durable flow', async () => {
    const start = vi.spyOn(provider, 'startConnect');
    const input = {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Work',
      idempotencyKey: 'connect-work-gmail',
    };
    const first = await service.start(OWNER, input);
    const repeated = await service.start(OWNER, input);

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({ state: 'pending', providerInstanceId: PROVIDER_ID });
    expect(start).toHaveBeenCalledTimes(1);
    await expect(service.start(OWNER, { ...input, toolkit: 'slack' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    } satisfies Partial<ConnectorAuthenticationFlowError>);
  });

  it('reads an owner-bound durable status by id or idempotency claim without polling the provider', async () => {
    const poll = vi.spyOn(provider, 'pollConnect');
    const started = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      idempotencyKey: 'owner-status',
    });

    expect(service.status(OWNER, started.flowId)).toEqual(started);
    expect(service.findByIdempotencyKey(OWNER, 'owner-status')).toEqual(started);
    expect(service.findByIdempotencyKey(OWNER, 'absent')).toBeUndefined();
    expect(() => service.status(FOREIGN_OWNER, started.flowId)).toThrowError(
      expect.objectContaining({ code: 'flow_not_found' })
    );
    expect(poll).not.toHaveBeenCalled();
  });

  it('polls the private provider handle after a server restart and stores a stable connection', async () => {
    const started = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Work',
      idempotencyKey: 'restart-safe',
    });

    const restartedRegistry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    restartedRegistry.register(new RestartSafeProvider({ instanceId: PROVIDER_ID }), 'material-a');
    const restarted = new ConnectorAuthenticationFlowService({
      db,
      registry: restartedRegistry,
      now: () => NOW,
    });
    const completed = await restarted.poll(OWNER, started.flowId);

    expect(completed).toMatchObject({ state: 'connected', connectionId: expect.any(String) });
    expect(db.select().from(connections).all()).toHaveLength(1);
    expect(db.select().from(connectorAuthenticationFlows).get()).toMatchObject({
      providerFlowId: null,
      authorizeUrl: null,
      state: 'connected',
    });
    await expect(restarted.poll(FOREIGN_OWNER, started.flowId)).rejects.toMatchObject({
      code: 'flow_not_found',
    });
  });

  it('fails a pending authentication flow when the provider deployment mode changes', async () => {
    const started = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      idempotencyKey: 'mode-change',
    });

    registry.register(provider, 'material-a', 'managed');

    expect(service.status(OWNER, started.flowId)).toMatchObject({
      state: 'failed',
      reason: 'The provider configuration changed before authentication completed.',
    });
  });

  it('never replays a provider create whose outcome was ambiguous', async () => {
    const start = vi.spyOn(provider, 'startConnect').mockRejectedValue(new Error('socket closed'));
    const input = {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      idempotencyKey: 'ambiguous-start',
    };
    const first = await service.start(OWNER, input);
    const repeated = await service.start(OWNER, input);

    expect(first).toMatchObject({ state: 'start_unknown' });
    expect(repeated).toEqual(first);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('invalidates only interrupted start claims during boot recovery', () => {
    db.insert(connectorAuthenticationFlows)
      .values({
        id: 'starting-flow',
        ownerKind: OWNER.kind,
        ownerId: OWNER.installationId,
        idempotencyKey: 'starting',
        requestHash: 'hash-starting',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        providerFlowId: null,
        toolkit: 'gmail',
        state: 'starting',
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
    expect(service.invalidateInterruptedStarts()).toBe(1);
    expect(
      db
        .select()
        .from(connectorAuthenticationFlows)
        .where(eq(connectorAuthenticationFlows.id, 'starting-flow'))
        .get()
    ).toMatchObject({ state: 'start_unknown', providerFlowId: null });
  });

  it('keeps the old connection paused when reconnect lacks positive same-account evidence', async () => {
    const existing = insertActiveConnection(db);
    vi.spyOn(provider, 'pollConnect').mockResolvedValue({
      status: 'connected',
      account: {
        externalAccountRef: 'external:gmail:Different' as never,
        toolkit: 'gmail',
        label: 'Different',
        status: 'active',
        custody: 'managed',
      },
    });

    const started = await service.reconnect(OWNER, existing, 'reconnect-with-different-account');
    const completed = await service.poll(OWNER, started.flowId);
    expect(completed).toMatchObject({ state: 'connected' });
    expect(completed.state === 'connected' && completed.connectionId).not.toBe(existing);
    expect(db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled).toBe(
      false
    );
  });

  it('does not re-pause a completed reconnect when its idempotency key is replayed', async () => {
    const existing = insertActiveConnection(db);
    const started = await service.reconnect(OWNER, existing, 'same-account-reconnect');
    const completed = await service.poll(OWNER, started.flowId);
    expect(completed).toMatchObject({ state: 'connected', connectionId: existing });
    expect(db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled).toBe(
      true
    );

    await expect(service.reconnect(OWNER, existing, 'same-account-reconnect')).resolves.toEqual(
      completed
    );
    expect(db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled).toBe(
      true
    );
  });

  it('refuses a conflicting reconnect key before pausing the connection', async () => {
    const existing = insertActiveConnection(db);
    await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'slack',
      idempotencyKey: 'already-claimed',
    });

    await expect(service.reconnect(OWNER, existing, 'already-claimed')).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled).toBe(
      true
    );
  });

  it('preserves the first terminal result when two polls overlap', async () => {
    const started = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Work',
      idempotencyKey: 'overlapping-polls',
    });
    let releaseFirst!: (value: ConnectPoll) => void;
    const firstResult = new Promise<ConnectPoll>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(provider, 'pollConnect')
      .mockReturnValueOnce(firstResult)
      .mockResolvedValueOnce({
        status: 'connected',
        account: {
          externalAccountRef: 'external:gmail:Work' as never,
          toolkit: 'gmail',
          label: 'Work',
          status: 'active',
          custody: 'managed',
        },
      });

    const slowPoll = service.poll(OWNER, started.flowId);
    const winner = await service.poll(OWNER, started.flowId);
    releaseFirst({ status: 'failed', error: 'late stale failure' });

    await expect(slowPoll).resolves.toEqual(winner);
    expect(winner).toMatchObject({ state: 'connected' });
    expect(db.select().from(connections).all()).toHaveLength(1);
  });

  it('expires a flow that crosses its deadline while provider polling is in flight', async () => {
    let clock = NOW;
    service = new ConnectorAuthenticationFlowService({
      db,
      registry,
      now: () => clock,
      flowTtlMs: 1_000,
    });
    const started = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      idempotencyKey: 'expires-in-flight',
    });
    let release!: (value: ConnectPoll) => void;
    vi.spyOn(provider, 'pollConnect').mockReturnValueOnce(
      new Promise<ConnectPoll>((resolve) => {
        release = resolve;
      })
    );
    const pendingPoll = service.poll(OWNER, started.flowId);
    clock = new Date(NOW.getTime() + 2_000);
    release({
      status: 'connected',
      account: {
        externalAccountRef: 'external:gmail:default' as never,
        toolkit: 'gmail',
        label: 'default',
        status: 'active',
        custody: 'managed',
      },
    });

    await expect(pendingPoll).resolves.toMatchObject({ state: 'expired' });
    expect(db.select().from(connections).all()).toHaveLength(0);
  });

  it('recovers an actual Composio provider flow from its remote handle after restart', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.includes('/auth_configs')) {
        return new Response(JSON.stringify({ items: [{ id: 'auth-config-a' }] }));
      }
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response(
          JSON.stringify({ id: 'ca_restart_a', redirect_url: 'https://provider.example/consent' })
        );
      }
      return new Response(
        JSON.stringify({
          id: 'ca_restart_a',
          status: 'ACTIVE',
          toolkit: { slug: 'gmail' },
          alias: 'Work',
        })
      );
    });
    const actualProvider = () =>
      new ComposioConnectorProvider({
        instanceId: PROVIDER_ID,
        operationClient: null,
        client: new FetchComposioHttpClient({
          apiKey: 'ak-hermetic',
          userId: 'owner-a',
          baseUrl: 'https://composio.example',
          fetchImpl: fetchImpl as typeof fetch,
        }),
      });
    registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    registry.register(actualProvider(), 'same-material');
    service = new ConnectorAuthenticationFlowService({ db, registry, now: () => NOW });
    const started = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Work',
      idempotencyKey: 'actual-composio-restart',
    });

    const restartedRegistry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    restartedRegistry.register(actualProvider(), 'same-material');
    const restarted = new ConnectorAuthenticationFlowService({
      db,
      registry: restartedRegistry,
      now: () => NOW,
    });
    await expect(restarted.poll(OWNER, started.flowId)).resolves.toMatchObject({
      state: 'connected',
      connectionId: expect.any(String),
    });
    expect(calls).toContain('GET /api/v3.1/connected_accounts/ca_restart_a');
  });

  it('rejects a mismatched provider account and never stores raw provider failure text', async () => {
    const started = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      idempotencyKey: 'safe-provider-failure',
    });
    vi.spyOn(provider, 'pollConnect').mockResolvedValue({
      status: 'failed',
      error: 'SECRET_MARKER_FROM_PROVIDER',
    });

    const failed = await service.poll(OWNER, started.flowId);
    expect(failed).toMatchObject({
      state: 'failed',
      reason: 'The provider could not complete authentication.',
    });
    expect(JSON.stringify(failed)).not.toContain('SECRET_MARKER_FROM_PROVIDER');
    expect(JSON.stringify(db.select().from(connectorAuthenticationFlows).all())).not.toContain(
      'SECRET_MARKER_FROM_PROVIDER'
    );

    const mismatched = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      idempotencyKey: 'wrong-toolkit-result',
    });
    vi.spyOn(provider, 'pollConnect').mockResolvedValue({
      status: 'connected',
      account: {
        externalAccountRef: 'external:slack:wrong' as never,
        toolkit: 'slack',
        label: 'Wrong',
        status: 'active',
        custody: 'managed',
      },
    });
    await expect(service.poll(OWNER, mismatched.flowId)).resolves.toMatchObject({
      state: 'failed',
      reason: 'The provider returned an account for a different connector route.',
    });
    expect(db.select().from(connections).all()).toHaveLength(0);
  });
});

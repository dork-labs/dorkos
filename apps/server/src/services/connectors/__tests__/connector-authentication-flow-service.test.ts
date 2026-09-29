import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectorAuthenticationFlows,
  connectorOperationRevisions,
  connectionOperationGrants,
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
import { ConnectorLifecycleService } from '../resources/lifecycle-service.js';
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

  it('keeps initial multi-account provider flows pending when a sibling connection closes', async () => {
    const connectionId = insertActiveConnection(db);
    const initial = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Another account',
      idempotencyKey: 'initial-sibling',
    });
    const reconnect = await service.reconnect(OWNER, connectionId, 'reconnect-existing');
    expect(initial.state).toBe('pending');
    expect(reconnect.state).toBe('pending');
    expect(service.invalidateConnectionFlows(OWNER, connectionId)).toBe(1);
    expect(service.status(OWNER, initial.flowId)).toMatchObject({ state: 'pending' });
    expect(service.status(OWNER, reconnect.flowId)).toMatchObject({ state: 'failed' });
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
      reason: 'This service setup changed while you were signing in. Start again.',
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

  it.each([
    ['request_failed', 503],
    ['conflict', 409],
  ] as const)(
    'keeps managed %s status %i ambiguous and does not replay it',
    async (code, status) => {
      const start = vi
        .spyOn(provider, 'startConnect')
        .mockRejectedValue(Object.assign(new Error('safe managed refusal'), { code, status }));
      const input = {
        providerInstanceId: PROVIDER_ID,
        toolkit: 'gmail',
        idempotencyKey: `ambiguous-${code}`,
      };

      const first = await service.start(OWNER, input);
      const repeated = await service.start(OWNER, input);

      expect(first).toMatchObject({ state: 'start_unknown' });
      expect(repeated).toEqual(first);
      expect(start).toHaveBeenCalledTimes(1);
    }
  );

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

  it('starts disconnected-account sign-in once without reopening local authority', async () => {
    const existing = insertActiveConnection(db);
    registry.recordDisconnect(existing);
    db.update(connections)
      .set({ externalCleanupState: 'complete' })
      .where(eq(connections.id, existing))
      .run();
    const start = vi.spyOn(provider, 'startConnect');

    const pending = await service.reconnect(OWNER, existing, 'disconnected-reconnect');
    expect(pending.state).toBe('pending');
    expect(registry.accountBinding(existing)?.status).toBe('revoked');
    await expect(service.reconnect(OWNER, existing, 'disconnected-reconnect')).resolves.toEqual(
      pending
    );
    expect(start).toHaveBeenCalledTimes(1);
    await expect(
      service.reconnect(FOREIGN_OWNER, existing, 'foreign-reconnect')
    ).rejects.toMatchObject({
      code: 'connection_not_found',
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reconnects a different returned identity without reviving the disconnected account or grants', async () => {
    const existing = insertActiveConnection(db);
    db.insert(connectorOperationRevisions)
      .values({
        id: 'read-v1',
        providerInstanceId: PROVIDER_ID,
        toolkit: 'gmail',
        operationSlug: 'GMAIL_FETCH_EMAILS',
        toolkitVersion: 'v1',
        schemaHash: 'read-schema',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: '{"type":"object"}',
        discoveredAt: NOW.toISOString(),
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'old-grant',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: existing,
        operationRevisionId: 'read-v1',
        createdBy: 'owner',
        createdAt: NOW.toISOString(),
      })
      .run();
    registry.recordDisconnect(existing);
    db.update(connections)
      .set({ externalCleanupState: 'complete', cleanupGeneration: 1 })
      .where(eq(connections.id, existing))
      .run();
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
    expect(
      db.select().from(connections).where(eq(connections.id, existing)).get()?.lifecycleState
    ).toBe('disconnected');
    expect(db.select().from(connectionOperationGrants).all()).toEqual([
      expect.objectContaining({
        id: 'old-grant',
        connectionId: existing,
        revokedAt: expect.any(String),
      }),
    ]);
  });

  it('refuses unknown cleanup before provider dispatch and fences a later cleanup generation', async () => {
    const existing = insertActiveConnection(db);
    registry.recordDisconnect(existing);
    db.update(connections)
      .set({ externalCleanupState: 'unknown' })
      .where(eq(connections.id, existing))
      .run();
    const start = vi.spyOn(provider, 'startConnect');
    await expect(service.reconnect(OWNER, existing, 'unknown-cleanup')).rejects.toMatchObject({
      code: 'connection_cleanup_pending',
    });
    expect(start).not.toHaveBeenCalled();
    db.update(connections)
      .set({ externalCleanupState: 'complete', cleanupGeneration: 1 })
      .where(eq(connections.id, existing))
      .run();
    const pending = await service.reconnect(OWNER, existing, 'after-ack');
    db.update(connections).set({ cleanupGeneration: 2 }).where(eq(connections.id, existing)).run();
    expect(await service.poll(OWNER, pending.flowId)).toMatchObject({ state: 'failed' });
    expect(registry.accountBinding(existing)?.status).toBe('revoked');
  });

  it.each([
    ['pending', /still ending this account’s earlier access/],
    ['failed', /couldn’t confirm .* Remove it from your apps, then connect the app again/],
    ['unknown', /couldn’t confirm .* Remove it from your apps, then connect the app again/],
  ] as const)(
    'refuses signing in again to an account whose cleanup is %s with words true to it',
    async (state, words) => {
      const existing = insertActiveConnection(db);
      registry.recordDisconnect(existing);
      db.update(connections)
        .set({ externalCleanupState: state })
        .where(eq(connections.id, existing))
        .run();
      const refusal = await service
        .reconnect(OWNER, existing, `refused-${state}`)
        .catch((error: unknown) => error as Error);
      expect(refusal).toMatchObject({ code: 'connection_cleanup_pending' });
      expect((refusal as Error).message).toMatch(words);
    }
  );

  it('lets a new sign-in to the same account win over an own-key cleanup DorkOS gave up on', async () => {
    // The person removed the app after DorkOS couldn't end its access, then
    // connected the same account again: it must not be blocked forever.
    const existing = insertActiveConnection(db);
    registry.recordDisconnect(existing);
    db.update(connections)
      .set({ externalCleanupState: 'failed', removedAt: NOW.toISOString() })
      .where(eq(connections.id, existing))
      .run();
    const started = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Original',
      idempotencyKey: 'same-account-again',
    });
    await expect(service.poll(OWNER, started.flowId)).resolves.toMatchObject({
      state: 'connected',
    });
    // The old cleanup would have ended the sign-in just made: it no longer runs.
    expect(
      db
        .select({ state: connections.externalCleanupState })
        .from(connections)
        .where(eq(connections.id, existing))
        .get()
    ).toEqual({ state: 'not_required' });
  });

  it('never lets a new sign-in cancel a cleanup DorkOS is sending at that moment', async () => {
    const existing = insertActiveConnection(db);
    db.update(connections)
      .set({ accountKey: 'material-a' })
      .where(eq(connections.id, existing))
      .run();
    let release!: () => void;
    const sent = vi.spyOn(provider, 'disconnect').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const lifecycle = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows: service,
      authorityCleanup: {
        revokeConnection: vi.fn(),
        revokeAgent: vi.fn(),
        revokeAgentConnection: vi.fn(),
      },
    });
    const disconnecting = lifecycle.disconnect(OWNER, existing, new AbortController().signal);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));

    // The same account signs in again while the delete is still out: it could
    // land after the new sign-in and end it, so the sign-in waits.
    const started = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Original',
      idempotencyKey: 'while-sending',
    });
    await expect(service.poll(OWNER, started.flowId)).resolves.toMatchObject({
      state: 'failed',
    });
    expect(
      db
        .select({ state: connections.externalCleanupState })
        .from(connections)
        .where(eq(connections.id, existing))
        .get()
    ).toEqual({ state: 'pending' });

    release();
    await expect(disconnecting).resolves.toMatchObject({ externalCleanup: 'complete' });
  });

  it('does not let an earlier initial flow reuse an identity acknowledged after it began', async () => {
    const existing = insertActiveConnection(db);
    registry.recordDisconnect(existing);
    db.update(connections)
      .set({ externalCleanupState: 'unknown' })
      .where(eq(connections.id, existing))
      .run();
    const pending = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Original',
      idempotencyKey: 'before-ack',
    });
    db.update(connections)
      .set({ externalCleanupState: 'complete', cleanupGeneration: 1 })
      .where(eq(connections.id, existing))
      .run();
    expect(await service.poll(OWNER, pending.flowId)).toMatchObject({ state: 'failed' });
    expect(registry.accountBinding(existing)?.status).toBe('revoked');
  });

  it('fails pre-upgrade pending flows without a snapshot before contacting the provider', async () => {
    const pending = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      idempotencyKey: 'legacy',
    });
    db.update(connectorAuthenticationFlows)
      .set({ cleanupSnapshotJson: null })
      .where(eq(connectorAuthenticationFlows.id, pending.flowId))
      .run();
    const poll = vi.spyOn(provider, 'pollConnect');
    expect(await service.poll(OWNER, pending.flowId)).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('Start a new sign-in'),
    });
    expect(poll).not.toHaveBeenCalled();
  });

  it.each(['start', 'poll'] as const)(
    'fences removal while provider %s is pending, including a different returned identity',
    async (phase) => {
      const existing = insertActiveConnection(db);
      registry.recordDisconnect(existing);
      db.update(connections)
        .set({ externalCleanupState: 'complete' })
        .where(eq(connections.id, existing))
        .run();
      const lifecycle = new ConnectorLifecycleService({
        db,
        registry,
        authenticationFlows: service,
        authorityCleanup: {
          revokeConnection: vi.fn(),
          revokeAgent: vi.fn(),
          revokeAgentConnection: vi.fn(),
        },
      });
      let releaseStart!: (value: ConnectStart) => void;
      let releasePoll!: (value: ConnectPoll) => void;
      if (phase === 'start')
        vi.spyOn(provider, 'startConnect').mockReturnValue(
          new Promise((resolve) => {
            releaseStart = resolve;
          })
        );
      else
        vi.spyOn(provider, 'pollConnect').mockReturnValue(
          new Promise((resolve) => {
            releasePoll = resolve;
          })
        );
      const starting = service.reconnect(OWNER, existing, `remove-during-${phase}`);
      let result: Promise<unknown> = starting;
      if (phase === 'poll') result = service.poll(OWNER, (await starting).flowId);
      lifecycle.remove(OWNER, existing);
      if (phase === 'start')
        releaseStart({ flowId: 'held-start', authorizeUrl: 'https://provider.example/authorize' });
      else
        releasePoll({
          status: 'connected',
          account: {
            externalAccountRef: 'different-ref' as never,
            toolkit: 'gmail',
            label: 'Different',
            status: 'active',
            custody: 'managed',
          },
        });
      expect(await result).toMatchObject({ state: 'failed' });
      expect(db.select().from(connections).all()).toEqual([
        expect.objectContaining({
          id: existing,
          lifecycleState: 'disconnected',
          removedAt: expect.any(String),
        }),
      ]);
    }
  );

  it('rejects an older initial flow after a newer sign-in has reactivated the same identity', async () => {
    const existing = insertActiveConnection(db);
    const old = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Original',
      idempotencyKey: 'old-active-flow',
    });
    registry.recordDisconnect(existing);
    db.update(connections)
      .set({ externalCleanupState: 'complete' })
      .where(eq(connections.id, existing))
      .run();
    const fresh = await service.reconnect(OWNER, existing, 'fresh-after-disconnect');
    expect(await service.poll(OWNER, fresh.flowId)).toMatchObject({
      state: 'connected',
      connectionId: existing,
    });
    expect(await service.poll(OWNER, old.flowId)).toMatchObject({ state: 'failed' });
    expect(db.select().from(connections).get()).toMatchObject({
      lifecycleState: 'connected',
      cleanupGeneration: 1,
    });
  });

  it('requires a fresh flow after removal before replacing the same provider identity', async () => {
    const existing = insertActiveConnection(db);
    registry.recordDisconnect(existing);
    db.update(connections)
      .set({ externalCleanupState: 'complete' })
      .where(eq(connections.id, existing))
      .run();
    const before = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Original',
      idempotencyKey: 'before-remove',
    });
    const lifecycle = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows: service,
      authorityCleanup: {
        revokeConnection: vi.fn(),
        revokeAgent: vi.fn(),
        revokeAgentConnection: vi.fn(),
      },
    });
    lifecycle.remove(OWNER, existing);
    expect(await service.poll(OWNER, before.flowId)).toMatchObject({ state: 'failed' });
    const after = await service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'gmail',
      label: 'Original',
      idempotencyKey: 'after-remove',
    });
    const connected = await service.poll(OWNER, after.flowId);
    expect(connected).toMatchObject({ state: 'connected' });
    expect(connected.state === 'connected' && connected.connectionId).not.toBe(existing);
    expect(db.select().from(connections).all()).toHaveLength(2);
    expect(db.select().from(connectionOperationGrants).all()).toEqual([]);
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

  it('keeps a pause the owner chose when signing in again completes', async () => {
    const existing = insertActiveConnection(db);
    const enabled = () =>
      db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled;
    db.update(connections).set({ enabled: false }).where(eq(connections.id, existing)).run();

    const started = await service.reconnect(OWNER, existing, 'paused-reconnect');
    await expect(service.poll(OWNER, started.flowId)).resolves.toMatchObject({
      state: 'connected',
      connectionId: existing,
    });
    // Still paused: signing in again never undoes the owner's choice.
    expect(enabled()).toBe(false);
  });

  it('unpauses after a sign-in again that an earlier unfinished one had paused', async () => {
    const existing = insertActiveConnection(db);
    const enabled = () =>
      db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled;
    // An earlier sign-in again paused the account and then ran out of time.
    const abandoned = await service.reconnect(OWNER, existing, 'abandoned-reconnect');
    db.update(connectorAuthenticationFlows)
      .set({ state: 'expired', completedAt: new Date().toISOString() })
      .where(eq(connectorAuthenticationFlows.id, abandoned.flowId))
      .run();
    expect(enabled()).toBe(false);

    const again = await service.reconnect(OWNER, existing, 'second-reconnect');
    await expect(service.poll(OWNER, again.flowId)).resolves.toMatchObject({
      state: 'connected',
    });
    // That pause was the abandoned sign-in's, not the owner's.
    expect(enabled()).toBe(true);
  });

  describe('a sign-in again never leaves an account paused', () => {
    const accountOf = (id: string) =>
      db
        .select({ enabled: connections.enabled, pausedBy: connections.pausedBy })
        .from(connections)
        .where(eq(connections.id, id))
        .get();

    it('pauses the account while it runs, and records that the pause is the sign-in’s', async () => {
      const existing = insertActiveConnection(db);
      await service.reconnect(OWNER, existing, 'running');
      expect(accountOf(existing)).toEqual({ enabled: false, pausedBy: 'sign_in' });
    });

    it('gives the account back when a sign-in nobody finished runs out of time', async () => {
      const existing = insertActiveConnection(db);
      let clock = NOW;
      const timed = new ConnectorAuthenticationFlowService({ db, registry, now: () => clock });
      const started = await timed.reconnect(OWNER, existing, 'abandoned');
      // Nobody reads the flow again: the sweep alone ends it.
      clock = new Date(NOW.getTime() + 60 * 60_000);
      expect(timed.expireAbandoned()).toBe(1);
      expect(
        db
          .select({ state: connectorAuthenticationFlows.state })
          .from(connectorAuthenticationFlows)
          .where(eq(connectorAuthenticationFlows.id, started.flowId))
          .get()
      ).toEqual({ state: 'expired' });
      expect(accountOf(existing)).toEqual({ enabled: true, pausedBy: null });
      expect(timed.expireAbandoned()).toBe(0);
    });

    it('gives the account back when the service can’t complete the sign-in', async () => {
      const existing = insertActiveConnection(db);
      vi.spyOn(provider, 'pollConnect').mockResolvedValue({ status: 'failed' });
      const started = await service.reconnect(OWNER, existing, 'failed');
      await expect(service.poll(OWNER, started.flowId)).resolves.toMatchObject({
        state: 'failed',
      });
      expect(accountOf(existing)).toEqual({ enabled: true, pausedBy: null });
    });

    it('gives the account back when the service never confirmed the sign-in started', async () => {
      const existing = insertActiveConnection(db);
      vi.spyOn(provider, 'startConnect').mockRejectedValue(new Error('no answer'));
      await expect(service.reconnect(OWNER, existing, 'unknown')).resolves.toMatchObject({
        state: 'start_unknown',
      });
      expect(accountOf(existing)).toEqual({ enabled: true, pausedBy: null });
    });

    it('gives the account back when a restart interrupted the sign-in’s start', async () => {
      const existing = insertActiveConnection(db);
      db.update(connections)
        .set({ enabled: false, pausedBy: 'sign_in' })
        .where(eq(connections.id, existing))
        .run();
      db.insert(connectorAuthenticationFlows)
        .values({
          id: 'interrupted',
          ownerKind: OWNER.kind,
          ownerId: OWNER.installationId,
          idempotencyKey: 'interrupted',
          requestHash: 'hash',
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          toolkit: 'gmail',
          reconnectConnectionId: existing,
          state: 'starting',
          createdAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
          updatedAt: NOW.toISOString(),
        })
        .run();
      expect(service.invalidateInterruptedStarts()).toBe(1);
      expect(accountOf(existing)).toEqual({ enabled: true, pausedBy: null });
    });

    it('gives the account it started from back when a different account signs in', async () => {
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
      const started = await service.reconnect(OWNER, existing, 'other-identity');
      await service.poll(OWNER, started.flowId);
      expect(accountOf(existing)).toEqual({ enabled: true, pausedBy: null });
    });

    it('keeps holding the account while another sign-in again for it still runs', async () => {
      const existing = insertActiveConnection(db);
      vi.spyOn(provider, 'pollConnect').mockResolvedValue({ status: 'failed' });
      const first = await service.reconnect(OWNER, existing, 'first');
      await service.reconnect(OWNER, existing, 'second');
      await service.poll(OWNER, first.flowId);
      expect(accountOf(existing)).toEqual({ enabled: false, pausedBy: 'sign_in' });
    });

    it('never lifts a pause the owner chose, even when the sign-in fails', async () => {
      const existing = insertActiveConnection(db);
      registry.setPaused(existing, true);
      vi.spyOn(provider, 'pollConnect').mockResolvedValue({ status: 'failed' });
      const started = await service.reconnect(OWNER, existing, 'owner-paused');
      expect(accountOf(existing)).toEqual({ enabled: false, pausedBy: 'owner' });
      await service.poll(OWNER, started.flowId);
      expect(accountOf(existing)).toEqual({ enabled: false, pausedBy: 'owner' });
    });
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
      reason: 'The service could not complete sign-in. Try again.',
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
      reason:
        'This sign-in request belongs to a different service setup. Start again from Connections.',
    });
    expect(db.select().from(connections).all()).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connections,
  connectorAuthenticationFlows,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorAuthenticationFlowService } from '../resources/authentication-flow-service.js';
import {
  ConnectorLifecycleService,
  type ConnectorManagedLifecyclePort,
} from '../resources/lifecycle-service.js';
import { ConnectorRegistry } from '../registry.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');
const NOW = '2026-09-06T18:00:00.000Z';

describe('ConnectorLifecycleService', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let authenticationFlows: ConnectorAuthenticationFlowService;
  const authorityCleanup = {
    revokeConnection: vi.fn(),
    revokeAgent: vi.fn(),
    revokeAgentConnection: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    provider = new FakeConnectorProvider({ instanceId: PROVIDER_ID, custody: 'self-host' });
    registry.register(provider, 'material-a');
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: PROVIDER_ID,
        externalAccountRef: 'provider-account-a',
        toolkit: 'gmail',
        label: 'Work Gmail',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    authenticationFlows = new ConnectorAuthenticationFlowService({ db, registry });
  });

  it('removes only a disconnected owner account while retaining its tombstone', () => {
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    expect(() => service.remove(OWNER, CONNECTION_ID)).toThrow('Disconnect this account');
    registry.recordDisconnect(CONNECTION_ID);
    expect(() =>
      service.remove({ kind: 'local_install', installationId: 'foreign' }, CONNECTION_ID)
    ).toThrow('Connection not found');
    db.update(connections)
      .set({ externalCleanupState: 'unknown' })
      .where(eq(connections.id, CONNECTION_ID))
      .run();
    expect(() => service.remove(OWNER, CONNECTION_ID)).toThrow('Finish disconnecting');
    db.update(connections)
      .set({ externalCleanupState: 'complete' })
      .where(eq(connections.id, CONNECTION_ID))
      .run();
    service.remove(OWNER, CONNECTION_ID);
    const row = db.select().from(connections).get();
    expect(row).toMatchObject({
      id: CONNECTION_ID,
      lifecycleState: 'disconnected',
      enabled: false,
      cleanupGeneration: 2,
      removedAt: expect.any(String),
    });
    service.remove(OWNER, CONNECTION_ID);
    expect(db.select().from(connections).get()?.removedAt).toBe(row?.removedAt);
  });

  // Disconnecting clears `enabled` as well as the lifecycle state, so signing the
  // same identity in again has to restore both. Restoring only the lifecycle state
  // leaves a row that reads `connected` in every listing and is still refused by
  // the executability gate in execution/authorization-service.ts — a reconnected
  // account no agent can use, which the browser suite caught as a 409.
  it('brings a disconnected account back usable when the owner signs in again', async () => {
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    await service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
    expect(db.select().from(connections).get()).toMatchObject({
      lifecycleState: 'disconnected',
      enabled: false,
    });

    const restored = registry.recordConnect(provider, {
      externalAccountRef: 'provider-account-a' as never,
      toolkit: 'gmail',
      label: 'Work Gmail',
      status: 'active',
      custody: 'self-host',
    });
    expect(restored).toMatchObject({ id: CONNECTION_ID, status: 'active' });
    expect(db.select().from(connections).get()).toMatchObject({
      lifecycleState: 'connected',
      enabled: true,
    });
  });

  // The other half of the same rule: pausing is an explicit owner choice about a
  // connected account, and a later sign-in must not quietly undo it.
  it('leaves a paused account paused when the owner signs in again', () => {
    registry.setPaused(CONNECTION_ID, true);
    const again = registry.recordConnect(provider, {
      externalAccountRef: 'provider-account-a' as never,
      toolkit: 'gmail',
      label: 'Work Gmail',
      status: 'active',
      custody: 'self-host',
    });
    expect(again).toMatchObject({ id: CONNECTION_ID, status: 'paused' });
    expect(db.select().from(connections).get()).toMatchObject({
      lifecycleState: 'connected',
      enabled: false,
    });
  });

  it('closes local authority and durable reconnects before provider disconnect settles', async () => {
    db.insert(connectorAuthenticationFlows)
      .values({
        id: 'flow-a',
        ownerKind: OWNER.kind,
        ownerId: OWNER.installationId,
        idempotencyKey: 'reconnect-a',
        requestHash: 'hash-a',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        providerFlowId: 'private-flow-a',
        toolkit: 'gmail',
        reconnectConnectionId: CONNECTION_ID,
        state: 'pending',
        createdAt: NOW,
        expiresAt: '2026-09-06T19:00:00.000Z',
        updatedAt: NOW,
      })
      .run();
    let release!: () => void;
    vi.spyOn(provider, 'disconnect').mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });

    const result = service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
    expect(db.select().from(connections).get()).toMatchObject({ lifecycleState: 'disconnected' });
    expect(db.select().from(connectorAuthenticationFlows).get()).toMatchObject({
      state: 'failed',
      providerFlowId: null,
    });
    expect(authorityCleanup.revokeConnection).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      reason: 'connection_removed',
    });

    release();
    await expect(result).resolves.toMatchObject({
      lifecycle: 'disconnected',
      externalCleanup: 'complete',
    });
  });

  it('coalesces concurrent deletes across service instances until cleanup is acknowledged', async () => {
    const releases: Array<() => void> = [];
    vi.spyOn(provider, 'disconnect').mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve))
    );
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    const first = service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
    expect(db.select().from(connections).get()).toMatchObject({
      enabled: false,
      lifecycleState: 'disconnected',
      externalCleanupState: 'pending',
      cleanupGeneration: 1,
    });
    const restarted = new ConnectorAuthenticationFlowService({ db, registry });
    await expect(restarted.reconnect(OWNER, CONNECTION_ID, 'while-pending')).rejects.toMatchObject({
      code: 'connection_cleanup_pending',
    });
    const secondService = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    const retry = secondService.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
    expect(releases).toHaveLength(1);
    releases[0]!();
    await first;
    await retry;
    expect(db.select().from(connections).get()).toMatchObject({
      enabled: false,
      lifecycleState: 'disconnected',
      externalCleanupState: 'complete',
      cleanupGeneration: 1,
    });
    await expect(
      restarted.reconnect(OWNER, CONNECTION_ID, 'after-complete')
    ).resolves.toMatchObject({ state: 'pending' });
  });

  it('lets an owner finish a historical unconfirmed disconnect without reopening access', async () => {
    registry.recordDisconnect(CONNECTION_ID);
    db.update(connections)
      .set({ externalCleanupState: 'unknown' })
      .where(eq(connections.id, CONNECTION_ID))
      .run();
    const disconnect = vi.spyOn(provider, 'disconnect').mockResolvedValue();
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    await expect(
      service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal)
    ).resolves.toMatchObject({ externalCleanup: 'complete', lifecycle: 'disconnected' });
    expect(disconnect).toHaveBeenCalledWith('provider-account-a');
    expect(db.select().from(connections).get()).toMatchObject({
      enabled: false,
      externalCleanupState: 'complete',
    });
  });

  it('reports failed external cleanup when the BYO provider is unavailable', async () => {
    registry.unregisterProviderInstance(PROVIDER_ID);
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });

    await expect(
      service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal)
    ).resolves.toMatchObject({
      lifecycle: 'disconnected',
      externalCleanup: 'failed',
      warning: { code: 'external_cleanup_failed' },
    });
    expect(authorityCleanup.revokeConnection).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      reason: 'connection_removed',
    });
  });

  it('keeps managed resume closed until the current hosted acknowledgement', async () => {
    db.update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();
    db.update(connections).set({ enabled: false }).where(eq(connections.id, CONNECTION_ID)).run();
    let release!: (value: Awaited<ReturnType<ConnectorManagedLifecyclePort['transition']>>) => void;
    const managed: ConnectorManagedLifecyclePort = {
      transition: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
      managed,
    });

    const result = service.resume(OWNER, CONNECTION_ID, new AbortController().signal);
    expect(db.select().from(connections).get()?.enabled).toBe(false);
    release({ authoritySync: { status: 'ready' }, applied: true, externalCleanup: 'not_required' });
    await expect(result).resolves.toMatchObject({ lifecycle: 'connected' });
    expect(db.select().from(connections).get()?.enabled).toBe(true);
  });

  it('does not reopen after provider material changes during managed resume', async () => {
    db.update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();
    db.update(connections).set({ enabled: false }).where(eq(connections.id, CONNECTION_ID)).run();
    let release!: (value: Awaited<ReturnType<ConnectorManagedLifecyclePort['transition']>>) => void;
    const managed: ConnectorManagedLifecyclePort = {
      transition: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
      managed,
    });

    const result = service.resume(OWNER, CONNECTION_ID, new AbortController().signal);
    db.update(connectorProviderInstances)
      .set({ executionConfigGeneration: 2 })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();
    release({ authoritySync: { status: 'ready' }, applied: true, externalCleanup: 'not_required' });

    await expect(result).resolves.toMatchObject({ lifecycle: 'paused' });
    expect(db.select().from(connections).get()?.enabled).toBe(false);
  });
});

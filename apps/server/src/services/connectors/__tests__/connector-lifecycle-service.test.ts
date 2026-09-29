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
import { CLEANUP_RETRY_DELAYS_MS } from '../resources/owed-cleanup.js';
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
        // Connected under the key saved now.
        accountKey: 'material-a',
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

  it('never retries a disconnect DorkOS couldn’t confirm, and never reopens access', async () => {
    registry.recordDisconnect(CONNECTION_ID);
    db.update(connections)
      .set({ externalCleanupState: 'unknown', enabled: false })
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
    ).resolves.toMatchObject({ externalCleanup: 'failed', lifecycle: 'disconnected' });
    // Readiness shows where to end the access instead; nothing is sent.
    expect(disconnect).not.toHaveBeenCalled();
    expect(db.select().from(connections).get()).toMatchObject({
      enabled: false,
      externalCleanupState: 'unknown',
    });
  });

  it('never counts an account’s access ended through a key it was never seen under', async () => {
    // Connected under key A; the person saves key B (from another project),
    // then disconnects. Key B can't see the account, so "not found" from it
    // would prove nothing while the sign-in made under A lives on.
    const disconnect = vi.spyOn(provider, 'disconnect');
    registry.register(provider, 'material-b');
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    await expect(
      service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal)
    ).resolves.toMatchObject({ lifecycle: 'disconnected', externalCleanup: 'failed' });
    expect(disconnect).not.toHaveBeenCalled();
    expect(db.select().from(connections).get()).toMatchObject({
      lifecycleState: 'disconnected',
      externalCleanupState: 'unknown',
      externalCleanupKey: 'material-a',
    });
    expect(authorityCleanup.revokeConnection).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      reason: 'connection_removed',
    });
  });

  it('never sends a delete for an account no key was ever seen holding', async () => {
    // A Nango or Composio account from before keys were recorded, not yet
    // included in a listing under today's key.
    db.update(connections).set({ accountKey: null }).where(eq(connections.id, CONNECTION_ID)).run();
    const disconnect = vi.spyOn(provider, 'disconnect');
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    await service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
    expect(disconnect).not.toHaveBeenCalled();
    expect(db.select().from(connections).get()).toMatchObject({
      externalCleanupState: 'unknown',
    });
  });

  it('finishes a raw MCP disconnect locally, whatever key or listing it has', async () => {
    // Raw MCP keeps no sign-in (custody external): nothing to end at a
    // service, so no key binds it and its end is never "unconfirmed".
    const raw = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('raw-a'),
      custody: 'external',
    });
    registry.register(raw, 'raw-material-1');
    db.insert(connections)
      .values({
        id: 'connection-raw',
        providerInstanceId: 'raw-a',
        externalAccountRef: 'mcp:notes',
        toolkit: 'notes',
        label: 'Notes',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        accountKey: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    // Adding another MCP server changes the raw fingerprint too.
    registry.register(raw, 'raw-material-2');
    const disconnect = vi.spyOn(raw, 'disconnect');
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    await expect(
      service.disconnect(
        OWNER,
        ConnectionIdSchema.parse('connection-raw'),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ externalCleanup: 'complete' });
    expect(disconnect).toHaveBeenCalledWith('mcp:notes');
  });

  it('never binds a raw MCP cleanup to an old fingerprint when it tries', async () => {
    const raw = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('raw-a'),
      custody: 'external',
    });
    registry.register(raw, 'raw-material-1');
    db.insert(connections)
      .values({
        id: 'connection-raw',
        providerInstanceId: 'raw-a',
        externalAccountRef: 'mcp:notes',
        toolkit: 'notes',
        label: 'Notes',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        // Seen under the fingerprint from before another MCP server was added.
        accountKey: 'raw-material-1',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    registry.register(raw, 'raw-material-2');
    const disconnect = vi.spyOn(raw, 'disconnect');
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    await expect(
      service.disconnect(
        OWNER,
        ConnectionIdSchema.parse('connection-raw'),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ externalCleanup: 'complete' });
    expect(disconnect).toHaveBeenCalledWith('mcp:notes');
    expect(
      db.select().from(connections).where(eq(connections.id, 'connection-raw')).get()
    ).toMatchObject({ externalCleanupState: 'complete', externalCleanupKey: 'raw-material-1' });
  });

  it('records the key an account is signed in under when it connects', () => {
    registry.register(provider, 'material-b');
    registry.recordConnect(provider, {
      externalAccountRef: 'provider-account-a' as never,
      toolkit: 'gmail',
      label: 'Work Gmail',
      status: 'active',
      custody: 'self-host',
    });
    expect(db.select().from(connections).get()?.accountKey).toBe('material-b');
  });

  it('ends the access through a new key once a listing under it includes the account', async () => {
    const disconnect = vi.spyOn(provider, 'disconnect');
    registry.register(provider, 'material-b');
    // The same project, with a new key: its listing includes the account.
    registry.recordSignInStatus(
      provider,
      [
        {
          externalAccountRef: 'provider-account-a' as never,
          toolkit: 'gmail',
          label: 'Work Gmail',
          status: 'active',
          custody: 'self-host',
        },
      ],
      NOW
    );
    expect(db.select().from(connections).get()?.accountKey).toBe('material-b');
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    await expect(
      service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal)
    ).resolves.toMatchObject({ externalCleanup: 'complete' });
    expect(disconnect).toHaveBeenCalledWith('provider-account-a');
  });

  it('ends the access only through the key it was reached through, never a different one', async () => {
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });
    const disconnect = vi
      .spyOn(provider, 'disconnect')
      .mockRejectedValueOnce(new Error('service down'));
    await service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
    expect(db.select().from(connections).get()).toMatchObject({
      externalCleanupState: 'pending',
      externalCleanupKey: 'material-a',
    });

    // The person saves a different key before DorkOS tries again. That key
    // can't see the account, so its "not found" would prove nothing.
    registry.register(provider, 'material-b');
    db.update(connections)
      .set({ externalCleanupRetryAt: null })
      .where(eq(connections.id, CONNECTION_ID))
      .run();
    await service.finishOwedCleanups(new AbortController().signal);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(db.select().from(connections).get()).toMatchObject({
      externalCleanupState: 'unknown',
      externalCleanupRetryAt: null,
    });

    // The same key back: nothing more happens on its own; the person was
    // already shown where to end the access themselves.
    registry.register(provider, 'material-a');
    await expect(service.finishOwedCleanups(new AbortController().signal)).resolves.toBe(0);
  });

  it('disconnects at once while the own key is gone, and leaves the cleanup to DorkOS', async () => {
    registry.unregisterProviderInstance(PROVIDER_ID);
    const service = new ConnectorLifecycleService({
      db,
      registry,
      authenticationFlows,
      authorityCleanup,
    });

    const result = await service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
    expect(result).toMatchObject({ lifecycle: 'disconnected', externalCleanup: 'pending' });
    expect(result).not.toHaveProperty('warning');
    expect(authorityCleanup.revokeConnection).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      reason: 'connection_removed',
    });
    // A way that isn't answering is not counted against the account.
    expect(db.select().from(connections).get()).toMatchObject({
      externalCleanupState: 'pending',
      externalCleanupAttempts: 0,
      externalCleanupRetryAt: null,
    });
  });

  describe('removing an account DorkOS still owes cleanup for', () => {
    it('always works, and keeps the cleanup current so DorkOS still finishes it', async () => {
      const service = new ConnectorLifecycleService({
        db,
        registry,
        authenticationFlows,
        authorityCleanup,
      });
      registry.unregisterProviderInstance(PROVIDER_ID);
      await service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
      const before = db.select().from(connections).get()!;

      service.remove(OWNER, CONNECTION_ID);

      expect(db.select().from(connections).get()).toMatchObject({
        removedAt: expect.any(String),
        externalCleanupState: 'pending',
        cleanupGeneration: before.cleanupGeneration,
      });
      // The key comes back: the background pass ends the access at the service.
      registry.register(provider, 'material-a');
      const disconnect = vi.spyOn(provider, 'disconnect');
      await expect(service.finishOwedCleanups(new AbortController().signal)).resolves.toBe(1);
      expect(disconnect).toHaveBeenCalledWith('provider-account-a');
      expect(db.select().from(connections).get()).toMatchObject({
        externalCleanupState: 'complete',
      });
    });
  });

  describe('owed own-key cleanup in the background', () => {
    let now: Date;
    let service: ConnectorLifecycleService;

    beforeEach(() => {
      now = new Date('2026-09-28T12:00:00.000Z');
      service = new ConnectorLifecycleService({
        db,
        registry,
        authenticationFlows,
        authorityCleanup,
        now: () => now,
      });
    });

    it('schedules a failed try again, waiting longer each time, then stops and says so', async () => {
      vi.spyOn(provider, 'disconnect').mockRejectedValue(new Error('service down'));
      await expect(
        service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal)
      ).resolves.toMatchObject({ externalCleanup: 'pending' });
      expect(db.select().from(connections).get()).toMatchObject({
        externalCleanupState: 'pending',
        externalCleanupAttempts: 1,
        externalCleanupRetryAt: new Date(now.getTime() + CLEANUP_RETRY_DELAYS_MS[0]).toISOString(),
      });

      // Not due yet: nothing is tried.
      await expect(service.finishOwedCleanups(new AbortController().signal)).resolves.toBe(0);

      for (let attempt = 2; attempt <= CLEANUP_RETRY_DELAYS_MS.length; attempt += 1) {
        now = new Date(Date.parse(db.select().from(connections).get()!.externalCleanupRetryAt!));
        await service.finishOwedCleanups(new AbortController().signal);
        expect(db.select().from(connections).get()).toMatchObject({
          externalCleanupAttempts: attempt,
          externalCleanupRetryAt: new Date(
            now.getTime() + CLEANUP_RETRY_DELAYS_MS[attempt - 1]!
          ).toISOString(),
        });
      }
      now = new Date(Date.parse(db.select().from(connections).get()!.externalCleanupRetryAt!));
      await service.finishOwedCleanups(new AbortController().signal);
      // Out of tries: DorkOS stops, and readiness shows the person what they can do.
      expect(db.select().from(connections).get()).toMatchObject({
        externalCleanupState: 'failed',
        externalCleanupRetryAt: null,
      });
      await expect(service.finishOwedCleanups(new AbortController().signal)).resolves.toBe(0);
    });

    it('skips an account whose way isn’t answering, without counting it', async () => {
      vi.spyOn(provider, 'disconnect').mockRejectedValue(new Error('service down'));
      await service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
      registry.unregisterProviderInstance(PROVIDER_ID);
      now = new Date(now.getTime() + 24 * 60 * 60_000);
      await expect(service.finishOwedCleanups(new AbortController().signal)).resolves.toBe(0);
      expect(db.select().from(connections).get()).toMatchObject({ externalCleanupAttempts: 1 });
    });

    it('“Try again now” tries at once, ahead of the schedule', async () => {
      const disconnect = vi
        .spyOn(provider, 'disconnect')
        .mockRejectedValueOnce(new Error('service down'));
      await service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
      await expect(
        service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal)
      ).resolves.toMatchObject({ externalCleanup: 'complete', lifecycle: 'disconnected' });
      expect(disconnect).toHaveBeenCalledTimes(2);
    });

    it('never overwrites a newer sign-in of the same account', async () => {
      let release!: () => void;
      vi.spyOn(provider, 'disconnect').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );
      const pending = service.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      // The account is signed in again (and its cleanup generation moves on)
      // while the try is still out.
      db.update(connections)
        .set({ externalCleanupState: 'not_required', cleanupGeneration: 99 })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      release();
      await pending;
      expect(db.select().from(connections).get()).toMatchObject({
        externalCleanupState: 'not_required',
      });
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

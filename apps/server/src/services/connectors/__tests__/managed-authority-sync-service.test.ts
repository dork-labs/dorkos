import { createHash } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';
import { ConnectorSubscriptionStore } from '../events/subscription-store.js';
import { ConnectorSubscriptionService } from '../events/subscription-service.js';
import { ConnectorEventGrantService } from '../events/grant-service.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type {
  ManagedConnectorAuthorityCommand,
  ManagedConnectorAuthorityCommandStatus,
} from '@dorkos/shared/connector-managed-schemas';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  ManagedAuthoritySyncService,
  type ManagedAuthorityCloudPort,
} from '../resources/managed-authority-sync-service.js';
import { ConnectorRegistry } from '../registry.js';
import { ConnectorLifecycleService } from '../resources/lifecycle-service.js';
import { ConnectorAuthenticationFlowService } from '../resources/authentication-flow-service.js';
import { logger } from '../../../lib/logger.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');
const MANAGED_CONNECTION_ID = 'managed-connection-a';
const START = Date.parse('2026-09-06T18:00:00.000Z');

function statusFor(
  command: ManagedConnectorAuthorityCommand,
  state: 'pending' | 'applied' = 'applied'
): ManagedConnectorAuthorityCommandStatus {
  return state === 'pending'
    ? {
        version: 1,
        commandId: command.commandId,
        managedConnectionId: command.managedConnectionId,
        scopeVersion: command.scopeVersion,
        state,
      }
    : {
        version: 1,
        commandId: command.commandId,
        managedConnectionId: command.managedConnectionId,
        scopeVersion: command.scopeVersion,
        state,
        externalCleanup: 'not_required',
        ...(command.kind === 'set_event_subscription' && {
          appliedEventScopeHash: createHash('sha256')
            .update(stableStringify(command))
            .digest('hex'),
        }),
      };
}

function cloudError(code: string, privateMessage = 'private hosted detail') {
  return Object.assign(new Error(privateMessage), { code });
}

describe('ManagedAuthoritySyncService', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let clock: number;
  let ids: number;
  let submitted: ManagedConnectorAuthorityCommand[];
  let cloud: ManagedAuthorityCloudPort;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    registry.register(
      new FakeConnectorProvider({ instanceId: PROVIDER_ID, custody: 'managed' }),
      'managed-material-a',
      'managed'
    );
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: PROVIDER_ID,
        externalAccountRef: MANAGED_CONNECTION_ID,
        toolkit: 'gmail',
        label: 'Work Gmail',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: new Date(START).toISOString(),
        updatedAt: new Date(START).toISOString(),
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-send',
        providerInstanceId: PROVIDER_ID,
        toolkit: 'gmail',
        operationSlug: 'gmail.send',
        toolkitVersion: 'v1',
        schemaHash: 'sha256:send',
        providerRevisionRef: '10000000-0000-4000-8000-000000000001',
        capabilityClassification: 'write',
        retryPolicy: 'never',
        inputSchemaJson: '{"type":"object"}',
        discoveredAt: new Date(START).toISOString(),
      })
      .run();
    clock = START;
    ids = 0;
    submitted = [];
    cloud = {
      submitConnectorAuthorityCommand: vi.fn(async (command) => {
        submitted.push(command);
        return statusFor(command);
      }),
      readConnectorAuthorityCommand: vi.fn(async () => {
        throw cloudError('not_found');
      }),
    };
  });

  function service(): ManagedAuthoritySyncService {
    return new ManagedAuthoritySyncService({
      db,
      cloud,
      now: () => new Date(clock),
      createId: () => `managed-command-${++ids}`,
      random: () => 0.5,
    });
  }

  function replace(sync = service()) {
    return sync.replaceAgentGrants({
      connectionId: CONNECTION_ID,
      managedConnectionId: MANAGED_CONNECTION_ID,
      agentId: 'agent-a',
      revisions: [
        {
          hostedRevisionId: '10000000-0000-4000-8000-000000000001',
          operationSlug: 'gmail.send',
          toolkitVersion: 'v1',
          schemaHash: 'sha256:send',
        },
      ],
      operationRevisionIds: ['revision-send'],
      providerInstanceId: PROVIDER_ID,
      executionConfigGeneration: 1,
      owner: OWNER,
      signal: new AbortController().signal,
    });
  }

  function eventReview(sync = service()) {
    const store = new ConnectorSubscriptionStore(db);
    const [definition] = store.discover(
      store.connection(OWNER, CONNECTION_ID),
      [
        {
          eventType: 'GMAIL_NEW_MESSAGE',
          displayName: 'New message',
          toolkit: 'gmail',
          toolkitVersion: 'v1',
          definitionHash: `sha256:${'a'.repeat(64)}`,
          filterSchema: { type: 'object', properties: {}, additionalProperties: false },
          payloadSchema: { type: 'object' },
          deliveryMode: 'polling',
          expectedCadenceSeconds: null,
          providerDefinitionRef: '10000000-0000-4000-8000-000000000099',
        },
      ],
      new Date(clock).toISOString()
    );
    const destinations = { authorize: () => true };
    const subscriptions = new ConnectorSubscriptionService(
      store,
      { resolveProviderInstance: () => undefined },
      destinations
    );
    const grants = new ConnectorEventGrantService(
      store,
      subscriptions,
      destinations,
      {
        reconcile: (id, version, signal) => sync.reconcileEventSubscription(id, version, signal),
        ready: (id, version) => sync.eventSubscriptionReady(id, version),
      },
      () => new Date(clock).toISOString()
    );
    const review = {
      reviewId: 'durable-owner-event-review',
      scopes: [
        {
          connectionId: CONNECTION_ID,
          definitionId: definition!.id,
          filter: {},
          agentId: 'agent-a',
          destination: { kind: 'agent' as const, id: 'agent-a' },
        },
      ],
    };
    return { store, grants, review, sync, signal: new AbortController().signal };
  }

  it('activates managed receive consent only through its exact full outbox ACK', async () => {
    const f = eventReview();
    const result = await f.grants.approve(OWNER, f.review, f.signal);
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('Event was not acknowledged');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      kind: 'set_event_subscription',
      subscriptionVersion: 1,
      scopeVersion: 1,
      hostedDefinitionId: '10000000-0000-4000-8000-000000000099',
      agentId: 'agent-a',
      destination: { kind: 'agent', id: 'agent-a' },
      filter: {},
      enabled: true,
    });
    expect(f.grants.ready(OWNER, result.selections, result.appliedEventScopeHash)).toBe(true);
    expect(await f.grants.approve(OWNER, f.review, f.signal)).toEqual(result);
    expect(submitted).toHaveLength(1);
  });
  it('refuses a successful-looking ACK with a different reviewed destination hash', async () => {
    const f = eventReview();
    vi.mocked(cloud.submitConnectorAuthorityCommand).mockImplementation(async (command) => ({
      ...statusFor(command),
      appliedEventScopeHash: '0'.repeat(64),
    }));
    const result = await f.grants.approve(OWNER, f.review, f.signal);
    expect(result.state).toBe('pending');
    expect(f.store.active(result.selections[0]!.subscriptionId)).toBeUndefined();
    expect(db.select().from(connectorManagedAuthorityOutbox).get()?.state).not.toBe('applied');
  });
  it('stages agent-wide receive revocation through existing recovery and old approval cannot reopen it', async () => {
    const f = eventReview();
    const result = await f.grants.approve(OWNER, f.review, f.signal);
    if (result.state !== 'ready') throw new Error('Event was not acknowledged');
    f.sync.stageAgentAccessRemoval({
      connectionId: CONNECTION_ID,
      managedConnectionId: MANAGED_CONNECTION_ID,
      agentId: 'agent-a',
      providerInstanceId: PROVIDER_ID,
      executionConfigGeneration: 1,
      owner: OWNER,
    });
    expect(f.grants.ready(OWNER, result.selections, result.appliedEventScopeHash)).toBe(false);
    expect(await f.grants.approve(OWNER, f.review, f.signal)).toEqual({
      state: 'unavailable',
      selections: result.selections,
    });
    await f.sync.recoverPending(f.signal);
    const disable = submitted.find(
      (command) => command.kind === 'set_event_subscription' && !command.enabled
    );
    expect(disable).toMatchObject({
      subscriptionId: result.selections[0]!.subscriptionId,
      subscriptionVersion: 2,
      scopeVersion: 2,
    });
    const count = submitted.length;
    await f.sync.recoverPending(f.signal);
    expect(submitted).toHaveLength(count);
  });
  it('keeps separately approved event consent when only operation grants are removed', async () => {
    const f = eventReview();
    const result = await f.grants.approve(OWNER, f.review, f.signal);
    if (result.state !== 'ready') throw new Error('Event was not acknowledged');
    await replace(f.sync);
    await f.sync.replaceAgentGrants({
      connectionId: CONNECTION_ID,
      managedConnectionId: MANAGED_CONNECTION_ID,
      agentId: 'agent-a',
      revisions: [],
      operationRevisionIds: [],
      providerInstanceId: PROVIDER_ID,
      executionConfigGeneration: 1,
      owner: OWNER,
      signal: f.signal,
    });
    expect(f.grants.ready(OWNER, result.selections, result.appliedEventScopeHash)).toBe(true);
    expect(submitted.filter((command) => command.kind === 'set_event_subscription')).toHaveLength(
      1
    );
  });
  it('does not apply an old hosted ACK after local receive revocation while the request was in flight', async () => {
    const f = eventReview();
    vi.mocked(cloud.submitConnectorAuthorityCommand).mockImplementation(async (command) => {
      if (command.kind === 'set_event_subscription')
        f.store.revoke(OWNER, command.subscriptionId, new Date(clock).toISOString());
      return statusFor(command);
    });
    const result = await f.grants.approve(OWNER, f.review, f.signal);
    expect(result.state).toBe('unavailable');
    expect(f.store.active(result.selections[0]!.subscriptionId)).toBeUndefined();
  });

  it('activates only the exact hosted revision even when retired metadata matches again', async () => {
    const current = db
      .select()
      .from(connectorOperationRevisions)
      .where(eq(connectorOperationRevisions.id, 'revision-send'))
      .get()!;
    db.insert(connectorOperationRevisions)
      .values({
        ...current,
        id: 'retired-send',
        providerRevisionRef: '10000000-0000-4000-8000-000000000002',
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'retired-grant',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: 'retired-send',
        createdBy: 'operator',
        createdAt: new Date(START).toISOString(),
        revokedAt: new Date(START).toISOString(),
      })
      .run();
    await replace();
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.operationRevisionId, 'retired-send'))
        .get()?.revokedAt
    ).toBe(new Date(START).toISOString());
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.operationRevisionId, 'revision-send'))
        .get()?.revokedAt
    ).toBeNull();
  });

  it('commits the exact monotonic command before network delivery', async () => {
    let release!: (status: ManagedConnectorAuthorityCommandStatus) => void;
    cloud.submitConnectorAuthorityCommand = (command) =>
      new Promise<ManagedConnectorAuthorityCommandStatus>((resolve) => {
        submitted.push(command);
        release = resolve;
      });

    const pending = replace();
    const row = db.select().from(connectorManagedAuthorityOutbox).get();
    expect(row).toMatchObject({
      connectionId: CONNECTION_ID,
      providerInstanceId: PROVIDER_ID,
      executionConfigGeneration: 1,
      ownerKind: OWNER.kind,
      ownerId: OWNER.installationId,
      managedConnectionId: MANAGED_CONNECTION_ID,
      state: 'pending',
      scopeVersion: 1,
    });
    expect(submitted).toHaveLength(1);
    expect(JSON.parse(row!.requestJson)).toEqual(submitted[0]);

    release(statusFor(submitted[0]!));
    await expect(pending).resolves.toMatchObject({
      applied: true,
      authoritySync: { status: 'ready' },
    });
    expect(db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('applied');
  });

  it.each(['owner retry', 'background recovery'] as const)(
    'finishes pending managed cleanup through %s after restart without another delete',
    async (path) => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return {
          ...statusFor(command),
          externalCleanup: 'pending',
        } as ManagedConnectorAuthorityCommandStatus;
      });
      await service().transition({
        connectionId: CONNECTION_ID,
        managedConnectionId: MANAGED_CONNECTION_ID,
        lifecycle: 'disconnected',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      });
      const stored = db.select().from(connectorManagedAuthorityOutbox).get()!;
      expect(stored).toMatchObject({
        state: 'pending',
        cleanupGeneration: 1,
        nextAttemptAt: expect.any(String),
      });
      expect(db.select().from(connections).get()).toMatchObject({
        externalCleanupState: 'pending',
        cleanupGeneration: 1,
        enabled: false,
      });
      cloud.readConnectorAuthorityCommand = vi.fn(
        async () =>
          ({
            ...statusFor(submitted[0]!),
            externalCleanup: 'complete',
          }) as ManagedConnectorAuthorityCommandStatus
      );
      clock = Date.parse(stored.nextAttemptAt!) + 1;
      if (path === 'owner retry')
        await expect(
          service().transition({
            connectionId: CONNECTION_ID,
            managedConnectionId: MANAGED_CONNECTION_ID,
            lifecycle: 'disconnected',
            providerInstanceId: PROVIDER_ID,
            executionConfigGeneration: 1,
            owner: OWNER,
            signal: new AbortController().signal,
          })
        ).resolves.toMatchObject({ externalCleanup: 'complete' });
      else await expect(service().recoverPending(new AbortController().signal)).resolves.toBe(1);
      expect(db.select().from(connectorManagedAuthorityOutbox).all()).toHaveLength(1);
      expect(cloud.readConnectorAuthorityCommand).toHaveBeenCalledWith(
        stored.commandId,
        expect.any(AbortSignal)
      );
      expect(cloud.submitConnectorAuthorityCommand).toHaveBeenCalledTimes(1);
      expect(db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('applied');
      expect(db.select().from(connections).get()).toMatchObject({
        externalCleanupState: 'complete',
        cleanupGeneration: 1,
        enabled: false,
      });
    }
  );

  it('recovers an ambiguous POST by reading first and repeats the same command only after 404', async () => {
    cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
      submitted.push(command);
      if (submitted.length === 1) throw cloudError('network_error');
      return statusFor(command);
    });
    const sync = service();

    await expect(replace(sync)).resolves.toMatchObject({
      applied: false,
      authoritySync: { status: 'pending' },
    });
    const stored = db.select().from(connectorManagedAuthorityOutbox).get()!;
    clock = Date.parse(stored.nextAttemptAt!) + 1;

    await expect(sync.recoverPending(new AbortController().signal)).resolves.toBe(1);
    expect(cloud.readConnectorAuthorityCommand).toHaveBeenCalledWith(
      stored.commandId,
      expect.any(AbortSignal)
    );
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual(submitted[0]);
    expect(db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('applied');
  });

  it('cannot let an older delayed acknowledgement replace the latest scope', async () => {
    let releaseFirst!: (status: ManagedConnectorAuthorityCommandStatus) => void;
    cloud.submitConnectorAuthorityCommand = (command) => {
      submitted.push(command);
      if (submitted.length === 1) {
        return new Promise<ManagedConnectorAuthorityCommandStatus>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve(statusFor(command));
    };
    const sync = service();

    const first = replace(sync);
    await expect(replace(sync)).resolves.toMatchObject({ applied: true });
    releaseFirst(statusFor(submitted[0]!));
    await expect(first).resolves.toMatchObject({ applied: false });

    const rows = db.select().from(connectorManagedAuthorityOutbox).all();
    expect(rows.map((row) => row.state)).toEqual(['superseded', 'applied']);
    expect(db.select().from(connectorManagedAuthorityScopes).get()).toMatchObject({
      scopeVersion: 2,
      lastCommandId: submitted[1]!.commandId,
    });
  });

  it('refuses a cloud acknowledgement after local provider material changes', async () => {
    let release!: (status: ManagedConnectorAuthorityCommandStatus) => void;
    cloud.submitConnectorAuthorityCommand = (command) =>
      new Promise<ManagedConnectorAuthorityCommandStatus>((resolve) => {
        submitted.push(command);
        release = resolve;
      });
    const pending = replace();
    db.update(connectorProviderInstances)
      .set({ executionConfigGeneration: 2 })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();

    release(statusFor(submitted[0]!));
    await expect(pending).resolves.toMatchObject({ applied: false });
    expect(db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('superseded');
  });

  it('persists a safe relink refusal without leaking hosted response details', async () => {
    cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
      throw cloudError('permission_upgrade_required', 'secret hosted account and stack trace');
    });

    await expect(replace()).resolves.toEqual({
      authoritySync: {
        status: 'failed',
        reason: 'Relink this instance to enable managed connections.',
      },
      applied: false,
      externalCleanup: 'not_required',
    });
    const row = db.select().from(connectorManagedAuthorityOutbox).get()!;
    expect(row).toMatchObject({
      state: 'rejected',
      safeReason: 'Relink this instance to enable managed connections.',
      nextAttemptAt: null,
    });
    expect(JSON.stringify(row)).not.toContain('secret hosted');
  });

  it('commits a managed pause and its outbox command before awaiting the cloud', async () => {
    let release!: (status: ManagedConnectorAuthorityCommandStatus) => void;
    cloud.submitConnectorAuthorityCommand = (command) =>
      new Promise((resolve) => {
        submitted.push(command);
        release = resolve;
      });
    const sync = service();

    const pending = sync.transition({
      connectionId: CONNECTION_ID,
      managedConnectionId: MANAGED_CONNECTION_ID,
      lifecycle: 'paused',
      providerInstanceId: PROVIDER_ID,
      executionConfigGeneration: 1,
      owner: OWNER,
      signal: new AbortController().signal,
    });

    expect(db.select().from(connections).get()?.enabled).toBe(false);
    expect(db.select().from(connectorManagedAuthorityOutbox).get()).toMatchObject({
      state: 'pending',
      scopeKind: 'connection_lifecycle',
    });
    release(statusFor(submitted[0]!));
    await expect(pending).resolves.toMatchObject({ applied: true });
  });

  it('rolls back local closure when the durable lifecycle command cannot append', async () => {
    const sync = new ManagedAuthoritySyncService({
      db,
      cloud,
      now: () => new Date(clock),
      createId: () => 'duplicate-command',
      random: () => 0.5,
    });
    await sync.transition({
      connectionId: CONNECTION_ID,
      managedConnectionId: MANAGED_CONNECTION_ID,
      lifecycle: 'active',
      providerInstanceId: PROVIDER_ID,
      executionConfigGeneration: 1,
      owner: OWNER,
      signal: new AbortController().signal,
    });

    await expect(
      sync.transition({
        connectionId: CONNECTION_ID,
        managedConnectionId: MANAGED_CONNECTION_ID,
        lifecycle: 'paused',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow();
    expect(db.select().from(connections).get()?.enabled).toBe(true);
  });

  it('never records applied when local grant activation rolls back', async () => {
    db.$client.exec(`
      CREATE TRIGGER reject_managed_grant_activation
      BEFORE UPDATE OF revoked_at ON connection_operation_grants
      WHEN NEW.revoked_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'activation refused');
      END;
    `);

    await expect(replace()).resolves.toMatchObject({
      applied: false,
      authoritySync: { status: 'pending' },
    });
    expect(db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('pending');
    expect(db.select().from(connectionOperationGrants).get()?.revokedAt).not.toBeNull();
  });

  it('compacts old terminal payloads while retaining the durable command tombstone', async () => {
    const sync = service();
    await replace(sync);
    const before = db.select().from(connectorManagedAuthorityOutbox).get()!;
    clock += 31 * 24 * 60 * 60 * 1_000;

    expect(sync.compactTerminal(new Date(clock - 24 * 60 * 60 * 1_000).toISOString())).toBe(1);
    expect(db.select().from(connectorManagedAuthorityOutbox).get()).toMatchObject({
      commandId: before.commandId,
      requestHash: before.requestHash,
      scopeVersion: before.scopeVersion,
      requestJson: '{}',
      compactedAt: new Date(clock).toISOString(),
    });
    expect(db.select().from(connectorManagedAuthorityScopes).get()).toMatchObject({
      lastCommandId: before.commandId,
      lastCommandHash: before.requestHash,
      scopeVersion: before.scopeVersion,
    });
  });
  describe('a disconnect whose hosted sign-out stalls', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function disconnect(sync = service()) {
      return sync.transition({
        connectionId: CONNECTION_ID,
        managedConnectionId: MANAGED_CONNECTION_ID,
        lifecycle: 'disconnected',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      });
    }

    function cleanupStatus(
      command: ManagedConnectorAuthorityCommand,
      externalCleanup: 'pending' | 'complete' | 'failed'
    ): ManagedConnectorAuthorityCommandStatus {
      return { ...statusFor(command), externalCleanup } as ManagedConnectorAuthorityCommandStatus;
    }

    function outbox() {
      return db.select().from(connectorManagedAuthorityOutbox).get()!;
    }

    it.each(['background recovery', 'Finish disconnecting'] as const)(
      'sends the same command again through %s until an applied-but-pending cleanup completes',
      async (path) => {
        const cleanup: Array<'pending' | 'complete'> = ['pending', 'pending', 'complete'];
        cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
          submitted.push(command);
          return cleanupStatus(command, cleanup.shift()!);
        });
        cloud.readConnectorAuthorityCommand = vi.fn(async () =>
          cleanupStatus(submitted[0]!, 'pending')
        );
        const sync = service();

        await expect(disconnect(sync)).resolves.toMatchObject({ externalCleanup: 'pending' });
        const first = outbox();
        expect(first).toMatchObject({
          state: 'pending',
          safeReason: 'DorkOS’s servers haven’t finished disconnecting this account.',
        });

        // The hosted row reads applied with cleanup pending: reading alone never
        // finishes it, so the exact command goes out again.
        clock = Date.parse(first.nextAttemptAt!) + 1;
        const again =
          path === 'background recovery'
            ? await sync.recoverPending(new AbortController().signal).then(() => undefined)
            : await disconnect(sync);
        if (again)
          expect(again).toMatchObject({
            externalCleanup: 'pending',
            authoritySync: {
              status: 'pending',
              reason: 'DorkOS’s servers haven’t finished disconnecting this account.',
              retryAt: expect.any(String),
            },
          });
        expect(submitted).toHaveLength(2);
        expect(submitted[1]).toEqual(submitted[0]);
        const second = outbox();
        expect(second.state).toBe('pending');
        // Backoff grows between tries rather than hammering the hosted side.
        expect(Date.parse(second.nextAttemptAt!) - clock).toBeGreaterThan(
          Date.parse(first.nextAttemptAt!) - START
        );

        clock = Date.parse(second.nextAttemptAt!) + 1;
        await sync.recoverPending(new AbortController().signal);
        expect(submitted).toHaveLength(3);
        expect(submitted[2]).toEqual(submitted[0]);
        expect(outbox()).toMatchObject({ state: 'applied', safeReason: null, nextAttemptAt: null });
        expect(db.select().from(connections).get()).toMatchObject({
          externalCleanupState: 'complete',
        });
        expect(db.select().from(connectorManagedAuthorityOutbox).all()).toHaveLength(1);
      }
    );

    it('sends a resume the hosted side still holds as pending again until it applies', async () => {
      {
        db.update(connections).set({ enabled: false }).run();
        const states: Array<'pending' | 'applied'> = ['pending', 'pending', 'applied'];
        cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
          submitted.push(command);
          return statusFor(command, states.shift()!);
        });
        cloud.readConnectorAuthorityCommand = vi.fn(async () =>
          statusFor(submitted[0]!, 'pending')
        );
        const sync = service();
        const resume = () =>
          sync.transition({
            connectionId: CONNECTION_ID,
            managedConnectionId: MANAGED_CONNECTION_ID,
            lifecycle: 'active',
            providerInstanceId: PROVIDER_ID,
            executionConfigGeneration: 1,
            owner: OWNER,
            signal: new AbortController().signal,
          });

        await expect(resume()).resolves.toMatchObject({
          applied: false,
          authoritySync: {
            status: 'pending',
            reason: 'DorkOS’s servers haven’t finished this change yet.',
          },
        });
        const first = outbox();
        expect(first.safeReason).toBe('DorkOS’s servers haven’t finished this change yet.');

        // Reading alone never settles a pending resume, so the exact command
        // goes out again (an owner's own retry is a new command, not this path).
        clock = Date.parse(first.nextAttemptAt!) + 1;
        await sync.recoverPending(new AbortController().signal);
        expect(submitted).toHaveLength(2);
        expect(submitted[1]).toEqual(submitted[0]);
        expect(outbox().state).toBe('pending');

        clock = Date.parse(outbox().nextAttemptAt!) + 1;
        await sync.recoverPending(new AbortController().signal);
        expect(submitted).toHaveLength(3);
        expect(submitted[2]).toEqual(submitted[0]);
        expect(outbox()).toMatchObject({ state: 'applied', safeReason: null });
        expect(db.select().from(connections).get()?.enabled).toBe(true);
      }
    });

    it('gives no retry reason to a pending command that recovery only re-reads', async () => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return statusFor(command, 'pending');
      });
      await expect(replace()).resolves.toMatchObject({
        applied: false,
        authoritySync: { status: 'pending' },
      });
      const stored = outbox();
      expect(stored).toMatchObject({ state: 'pending', safeReason: null });
      expect((await replace()).authoritySync).toEqual({ status: 'pending' });
    });

    it('does not send again once the hosted read says cleanup settled', async () => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return cleanupStatus(command, 'pending');
      });
      const sync = service();
      await disconnect(sync);
      cloud.readConnectorAuthorityCommand = vi.fn(async () =>
        cleanupStatus(submitted[0]!, 'failed')
      );
      clock = Date.parse(outbox().nextAttemptAt!) + 1;
      await sync.recoverPending(new AbortController().signal);
      expect(submitted).toHaveLength(1);
      expect(outbox().state).toBe('applied');
      expect(db.select().from(connections).get()?.externalCleanupState).toBe('failed');
    });

    it('finishes an account disconnected before cleanup was tracked (unknown) through the same path', async () => {
      db.update(connections)
        .set({ lifecycleState: 'disconnected', enabled: false, externalCleanupState: 'unknown' })
        .run();
      const cleanup: Array<'pending' | 'complete'> = ['pending', 'complete'];
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return cleanupStatus(command, cleanup.shift()!);
      });
      cloud.readConnectorAuthorityCommand = vi.fn(async () =>
        cleanupStatus(submitted[0]!, 'pending')
      );
      const sync = service();

      await disconnect(sync);
      expect(db.select().from(connections).get()?.externalCleanupState).toBe('pending');
      clock = Date.parse(outbox().nextAttemptAt!) + 1;
      await sync.recoverPending(new AbortController().signal);

      expect(submitted).toHaveLength(2);
      expect(submitted[1]).toEqual(submitted[0]);
      expect(db.select().from(connections).get()?.externalCleanupState).toBe('complete');
    });

    it('stores a plain reason and retry time, and logs a stalled command without flooding', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      // The hosted text rides in the message and the cause; none of it may
      // reach the stored row, the returned state or the log line.
      const serverError = () =>
        Object.assign(cloudError('request_failed', 'private hosted detail'), {
          status: 500,
          cause: new Error('private hosted cause'),
        });
      cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw serverError();
      });
      cloud.readConnectorAuthorityCommand = vi.fn(async () => {
        throw serverError();
      });
      const sync = service();

      const result = await disconnect(sync);
      const stored = outbox();
      expect(stored).toMatchObject({
        state: 'pending',
        safeReason: 'DorkOS’s servers had a problem.',
        nextAttemptAt: expect.any(String),
      });
      expect(result.authoritySync).toEqual({
        status: 'pending',
        reason: 'DorkOS’s servers had a problem.',
        retryAt: stored.nextAttemptAt,
      });
      for (const seen of [stored, result, warn.mock.calls]) {
        expect(JSON.stringify(seen)).not.toMatch(/private hosted (detail|cause)/);
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toMatchObject({
        code: 'request_failed',
        status: 500,
        commandId: stored.commandId,
        scopeKind: 'connection_lifecycle',
        nextAttemptAt: stored.nextAttemptAt,
      });

      // The same failure again soon after stays quiet.
      clock = Date.parse(stored.nextAttemptAt!) + 1;
      await sync.recoverPending(new AbortController().signal);
      expect(warn).toHaveBeenCalledTimes(1);

      // A different failure is logged at once, with its own reason.
      cloud.readConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('network_error');
      });
      clock = Date.parse(outbox().nextAttemptAt!) + 1;
      await sync.recoverPending(new AbortController().signal);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]![1]).toMatchObject({ code: 'network_error' });
      expect(outbox().safeReason).toBe('Couldn’t reach DorkOS’s servers.');

      // The same failure is logged again once enough time has passed.
      clock += 15 * 60_000;
      await sync.recoverPending(new AbortController().signal);
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it('logs the class of a failure on this computer, never its message', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw new TypeError('private local detail');
      });
      await expect(disconnect()).resolves.toMatchObject({
        authoritySync: {
          status: 'pending',
          reason: 'Something went wrong on this computer during the last try.',
        },
      });
      expect(warn.mock.calls[0]![1]).toMatchObject({ code: 'local_error', errorName: 'TypeError' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private local detail');
    });

    it('gives up on a hung hosted request so recovery keeps running', async () => {
      const deadlines: AbortController[] = [];
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return cleanupStatus(command, 'pending');
      });
      const hang = vi.fn(
        (_id: string, signal?: AbortSignal) =>
          new Promise<ManagedConnectorAuthorityCommandStatus>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason));
          })
      );
      cloud.readConnectorAuthorityCommand = hang;
      const sync = new ManagedAuthoritySyncService({
        db,
        cloud,
        now: () => new Date(clock),
        createId: () => `managed-command-${++ids}`,
        random: () => 0.5,
        timeoutSignal: (timeoutMs) => {
          expect(timeoutMs).toBe(30_000);
          const deadline = new AbortController();
          deadlines.push(deadline);
          return deadline.signal;
        },
      });
      await disconnect(sync);
      clock = Date.parse(outbox().nextAttemptAt!) + 1;

      const recovering = sync.recoverPending(new AbortController().signal);
      await vi.waitFor(() => expect(hang).toHaveBeenCalledTimes(1));
      // While the request hangs, a second pass is refused rather than stacked.
      await expect(sync.recoverPending(new AbortController().signal)).resolves.toBe(0);
      deadlines.at(-1)!.abort(new Error('deadline'));
      await expect(recovering).resolves.toBe(1);
      expect(outbox()).toMatchObject({
        state: 'pending',
        safeReason: 'DorkOS’s servers didn’t answer in time.',
      });

      // The pass is free again: the next one really reaches the hosted side.
      cloud.readConnectorAuthorityCommand = vi.fn(async () =>
        cleanupStatus(submitted[0]!, 'complete')
      );
      clock = Date.parse(outbox().nextAttemptAt!) + 1;
      await expect(sync.recoverPending(new AbortController().signal)).resolves.toBe(1);
      expect(db.select().from(connections).get()?.externalCleanupState).toBe('complete');
    });
  });
  describe('refused changes are never a dead end', () => {
    function rejected(
      command: ManagedConnectorAuthorityCommand,
      rejectionCode: 'connection_unavailable' | 'revision_unavailable' | 'scope_conflict'
    ): ManagedConnectorAuthorityCommandStatus {
      return {
        version: 1,
        commandId: command.commandId,
        managedConnectionId: command.managedConnectionId,
        scopeVersion: command.scopeVersion,
        state: 'rejected',
        rejectionCode,
      };
    }

    const grants = () =>
      db
        .select({
          operationRevisionId: connectionOperationGrants.operationRevisionId,
          revokedAt: connectionOperationGrants.revokedAt,
        })
        .from(connectionOperationGrants)
        .all();

    it('remembers why the hosted side refused a change', async () => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      await replace();
      expect(db.select().from(connectorManagedAuthorityOutbox).get()).toMatchObject({
        state: 'rejected',
        rejectionCode: 'unauthorized',
      });
    });

    it('sends a change the old link refused again once the account is linked again', async () => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      const sync = service();
      await replace(sync);
      expect(grants()).toEqual([
        { operationRevisionId: 'revision-send', revokedAt: expect.any(String) },
      ]);

      // Linked again: the instance's setup moves on, and the hosted side answers.
      db.update(connectorProviderInstances)
        .set({ executionConfigGeneration: 2 })
        .where(eq(connectorProviderInstances.id, PROVIDER_ID))
        .run();
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return statusFor(command);
      });
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(1);

      expect(submitted.at(-1)).toMatchObject({
        kind: 'replace_agent_grants',
        agentId: 'agent-a',
        scopeVersion: 2,
        revisions: [expect.objectContaining({ operationSlug: 'gmail.send' })],
      });
      // The access the owner gave now works.
      expect(grants()).toEqual([{ operationRevisionId: 'revision-send', revokedAt: null }]);
      // Nothing is left to send again.
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(0);
    });

    it('never sends a change refused for another reason just because of a relink', async () => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        rejected(command, 'scope_conflict')
      );
      const sync = service();
      await replace(sync);
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(0);
    });

    it('settles a refused change with exactly the access the owner was shown, never the refused one', async () => {
      // The owner gave agent-a Send; the hosted side refused. The review shows
      // agent-a with nothing (the refused grant never opened).
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return rejected(command, 'scope_conflict');
      });
      const sync = service();
      await replace(sync);
      const [commandId] = db.transaction((tx) =>
        sync.restageRefused(tx, { connectionId: CONNECTION_ID, why: 'confirmed' })
      );
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return statusFor(command);
      });
      await sync.deliverAgentGrantReplacement(commandId!, new AbortController().signal);
      // Confirming "nothing" sends nothing: the refused Send is not granted.
      expect(submitted.at(-1)).toMatchObject({ kind: 'replace_agent_grants', revisions: [] });
      expect(grants().every((grant) => grant.revokedAt !== null)).toBe(true);
    });

    it('confirms an agent’s current access when the refused actions are gone at the service', async () => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return rejected(command, 'revision_unavailable');
      });
      const sync = service();
      await replace(sync);
      const [commandId] = db.transaction((tx) =>
        sync.restageRefused(tx, { connectionId: CONNECTION_ID, why: 'confirmed' })
      );
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return statusFor(command);
      });
      await sync.deliverAgentGrantReplacement(commandId!, new AbortController().signal);
      expect(submitted.at(-1)).toMatchObject({ kind: 'replace_agent_grants', revisions: [] });
    });

    it('after a relink, sends what the agent holds now when its access changed since the refusal', async () => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      const sync = service();
      await replace(sync);
      // Later, the agent is deleted: its access here ends without a hosted change.
      clock += 60_000;
      db.update(connectionOperationGrants)
        .set({ revokedAt: new Date(clock).toISOString() })
        .where(eq(connectionOperationGrants.agentId, 'agent-a'))
        .run();
      db.update(connectorProviderInstances)
        .set({ executionConfigGeneration: 2 })
        .where(eq(connectorProviderInstances.id, PROVIDER_ID))
        .run();
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return statusFor(command);
      });
      await sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal);
      // Never the old Send again: the deleted agent gets nothing back.
      expect(submitted.at(-1)).toMatchObject({ kind: 'replace_agent_grants', revisions: [] });
      expect(grants().every((grant) => grant.revokedAt !== null)).toBe(true);
    });

    it('closes an account whose connection the hosted side no longer has, with its end unconfirmed', async () => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        rejected(command, 'connection_unavailable')
      );
      const sync = service();
      await replace(sync);
      expect(db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'disconnected',
        enabled: false,
        closedBecause: 'service_gone',
        // Never "nothing owed": whether the sign-in lives on isn't known.
        externalCleanupState: 'unknown',
      });
      expect(grants().every((grant) => grant.revokedAt !== null)).toBe(true);
      // Never sent again, even when the owner confirms.
      expect(
        db.transaction((tx) =>
          sync.restageRefused(tx, { connectionId: CONNECTION_ID, why: 'confirmed' })
        )
      ).toEqual([]);
    });

    it('never closes an account because a resume was refused: it asks for a sign-in instead', async () => {
      db.update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        rejected(command, 'connection_unavailable')
      );
      await service().transition({
        connectionId: CONNECTION_ID,
        managedConnectionId: MANAGED_CONNECTION_ID,
        lifecycle: 'active',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      });
      expect(db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        enabled: false,
        closedBecause: null,
        status: 'expired',
      });
    });

    it('can’t confirm the end of a disconnect the service no longer recognizes', async () => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        rejected(command, 'connection_unavailable')
      );
      await service().transition({
        connectionId: CONNECTION_ID,
        managedConnectionId: MANAGED_CONNECTION_ID,
        lifecycle: 'disconnected',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      });
      expect(db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'disconnected',
        externalCleanupState: 'unknown',
        closedBecause: null,
      });
    });

    it('sends a disconnect the old link refused again, so DorkOS still finishes it', async () => {
      cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      const sync = service();
      await sync.transition({
        connectionId: CONNECTION_ID,
        managedConnectionId: MANAGED_CONNECTION_ID,
        lifecycle: 'disconnected',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      });
      expect(db.select().from(connections).get()?.externalCleanupState).toBe('pending');
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return {
          ...statusFor(command),
          externalCleanup: 'complete',
        } as ManagedConnectorAuthorityCommandStatus;
      });
      await sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal);
      expect(submitted.at(-1)).toMatchObject({
        kind: 'set_connection_lifecycle',
        lifecycle: 'disconnected',
      });
      expect(db.select().from(connections).get()?.externalCleanupState).toBe('complete');
    });

    it('ends the Resume, Sign in again loop: a resume refused again after a sign-in closes it as gone', async () => {
      db.update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        rejected(command, 'connection_unavailable')
      );
      const resume = () =>
        service().transition({
          connectionId: CONNECTION_ID,
          managedConnectionId: MANAGED_CONNECTION_ID,
          lifecycle: 'active',
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          owner: OWNER,
          signal: new AbortController().signal,
        });
      await resume();
      expect(db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        status: 'expired',
      });
      // The person signs in again; the account reads signed in once more.
      db.update(connections)
        .set({ status: 'active' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      clock += 60_000;
      await resume();
      // Signing in can't fix it: gone, with "connect it again" and its end unconfirmed.
      expect(db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'disconnected',
        closedBecause: 'service_gone',
        externalCleanupState: 'unknown',
      });
    });

    it('never closes a healthy account on its first refusal after an earlier resume applied', async () => {
      db.update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      let refuse = true;
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        refuse ? rejected(command, 'connection_unavailable') : statusFor(command)
      );
      const lifecycle = (to: 'active' | 'paused') =>
        service().transition({
          connectionId: CONNECTION_ID,
          managedConnectionId: MANAGED_CONNECTION_ID,
          lifecycle: to,
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          owner: OWNER,
          signal: new AbortController().signal,
        });
      // Refused once; the person signs in again; the next resume applies.
      await lifecycle('active');
      db.update(connections)
        .set({ status: 'active' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      refuse = false;
      clock += 60_000;
      await lifecycle('active');
      expect(db.select().from(connections).get()).toMatchObject({ enabled: true });
      // Weeks later: paused, then one refused resume. Signing in may fix it.
      clock += 21 * 24 * 60 * 60_000;
      await lifecycle('paused');
      refuse = true;
      await lifecycle('active');
      expect(db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        status: 'expired',
        closedBecause: null,
      });
    });

    it('never counts a refused pause (recorded before this change) as a refused resume', async () => {
      db.update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      // An earlier refused pause, as the 0125 backfill names it.
      db.insert(connectorManagedAuthorityOutbox)
        .values({
          commandId: 'old-refused-pause',
          connectionId: CONNECTION_ID,
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          ownerKind: OWNER.kind,
          ownerId: OWNER.installationId,
          managedConnectionId: MANAGED_CONNECTION_ID,
          scopeKind: 'connection_lifecycle',
          subjectId: 'connection',
          scopeVersion: 1,
          requestHash: 'h',
          requestJson: JSON.stringify({
            version: 1,
            commandId: 'old-refused-pause',
            managedConnectionId: MANAGED_CONNECTION_ID,
            scopeVersion: 1,
            kind: 'set_connection_lifecycle',
            lifecycle: 'paused',
          }),
          state: 'rejected',
          rejectionCode: 'connection_unavailable',
          createdAt: new Date(clock).toISOString(),
          updatedAt: new Date(clock).toISOString(),
        })
        .run();
      db.insert(connectorManagedAuthorityScopes)
        .values({
          managedConnectionId: MANAGED_CONNECTION_ID,
          scopeKind: 'connection_lifecycle',
          subjectId: 'connection',
          scopeVersion: 1,
          lastCommandId: 'old-refused-pause',
          lastCommandHash: 'h',
          updatedAt: new Date(clock).toISOString(),
        })
        .run();
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        rejected(command, 'connection_unavailable')
      );
      await service().transition({
        connectionId: CONNECTION_ID,
        managedConnectionId: MANAGED_CONNECTION_ID,
        lifecycle: 'active',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      });
      expect(db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        status: 'expired',
      });
    });

    it('finishes a disconnect the ended link refused even after the account was removed', async () => {
      // The live incident: the link ended, Disconnect was refused, the person
      // removed the app, then linked the same DorkOS account again.
      cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      const sync = service();
      const lifecycle = new ConnectorLifecycleService({
        db,
        registry,
        authenticationFlows: new ConnectorAuthenticationFlowService({ db, registry }),
        authorityCleanup: {
          revokeConnection: vi.fn(),
          revokeAgent: vi.fn(),
          revokeAgentConnection: vi.fn(),
        },
        managed: sync,
      });
      await lifecycle.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
      lifecycle.remove(OWNER, CONNECTION_ID);
      expect(db.select().from(connections).get()).toMatchObject({
        removedAt: expect.any(String),
        externalCleanupState: 'pending',
      });

      db.update(connectorProviderInstances)
        .set({ executionConfigGeneration: 2 })
        .where(eq(connectorProviderInstances.id, PROVIDER_ID))
        .run();
      cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        submitted.push(command);
        return {
          ...statusFor(command),
          externalCleanup: 'complete',
        } as ManagedConnectorAuthorityCommandStatus;
      });
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(1);
      expect(submitted.at(-1)).toMatchObject({
        kind: 'set_connection_lifecycle',
        lifecycle: 'disconnected',
      });
      expect(db.select().from(connections).get()?.externalCleanupState).toBe('complete');
    });
  });
});

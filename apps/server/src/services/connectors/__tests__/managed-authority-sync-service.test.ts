import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      };
}

function cloudError(code: string, privateMessage = 'private hosted detail') {
  return Object.assign(new Error(privateMessage), { code });
}

describe('ManagedAuthoritySyncService', () => {
  let db: Db;
  let clock: number;
  let ids: number;
  let submitted: ManagedConnectorAuthorityCommand[];
  let cloud: ManagedAuthorityCloudPort;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    const registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    registry.register(
      new FakeConnectorProvider({ instanceId: PROVIDER_ID, custody: 'managed' }),
      'managed-material-a'
    );
    db.update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();
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
});

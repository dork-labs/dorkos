import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorProviderInstances,
  eq,
} from '@dorkos/db';
import type {
  ManagedConnectorAuthorityCommandStatus,
  ManagedConnectorAuthorityCommand,
} from '@dorkos/shared/connector-managed-schemas';
import { ManagedAuthoritySyncService } from '../../resources/managed-authority-sync-service.js';
import {
  OWNER,
  PROVIDER_ID,
  CONNECTION_ID,
  MANAGED_CONNECTION_ID,
  statusFor,
  cloudError,
  useManagedAuthoritySyncHarness,
  lifecycleChange,
  START,
} from './managed-authority-sync-service.fixtures.js';

/** The durable outbox command: ordering, recovery after restart, rollback, and a stalled hosted sign-out. */
describe('ManagedAuthoritySyncService', () => {
  const h = useManagedAuthoritySyncHarness();

  it('commits the exact monotonic command before network delivery', async () => {
    let release!: (status: ManagedConnectorAuthorityCommandStatus) => void;
    h.cloud.submitConnectorAuthorityCommand = (command) =>
      new Promise<ManagedConnectorAuthorityCommandStatus>((resolve) => {
        h.submitted.push(command);
        release = resolve;
      });

    const pending = h.replace();
    const row = h.db.select().from(connectorManagedAuthorityOutbox).get();
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
    expect(h.submitted).toHaveLength(1);
    expect(JSON.parse(row!.requestJson)).toEqual(h.submitted[0]);

    release(statusFor(h.submitted[0]!));
    await expect(pending).resolves.toMatchObject({
      applied: true,
      authoritySync: { status: 'ready' },
    });
    expect(h.db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('applied');
  });

  it.each(['owner retry', 'background recovery'] as const)(
    'finishes pending managed cleanup through %s after restart without another delete',
    async (path) => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return {
          ...statusFor(command),
          externalCleanup: 'pending',
        } as ManagedConnectorAuthorityCommandStatus;
      });
      await h.service().transition(lifecycleChange('disconnected'));
      const stored = h.db.select().from(connectorManagedAuthorityOutbox).get()!;
      expect(stored).toMatchObject({
        state: 'pending',
        cleanupGeneration: 1,
        nextAttemptAt: expect.any(String),
      });
      expect(h.db.select().from(connections).get()).toMatchObject({
        externalCleanupState: 'pending',
        cleanupGeneration: 1,
        enabled: false,
      });
      h.cloud.readConnectorAuthorityCommand = vi.fn(
        async () =>
          ({
            ...statusFor(h.submitted[0]!),
            externalCleanup: 'complete',
          }) as ManagedConnectorAuthorityCommandStatus
      );
      h.clock = Date.parse(stored.nextAttemptAt!) + 1;
      if (path === 'owner retry')
        await expect(
          h.service().transition(lifecycleChange('disconnected'))
        ).resolves.toMatchObject({ externalCleanup: 'complete' });
      else await expect(h.service().recoverPending(new AbortController().signal)).resolves.toBe(1);
      expect(h.db.select().from(connectorManagedAuthorityOutbox).all()).toHaveLength(1);
      expect(h.cloud.readConnectorAuthorityCommand).toHaveBeenCalledWith(
        stored.commandId,
        expect.any(AbortSignal)
      );
      expect(h.cloud.submitConnectorAuthorityCommand).toHaveBeenCalledTimes(1);
      expect(h.db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('applied');
      expect(h.db.select().from(connections).get()).toMatchObject({
        externalCleanupState: 'complete',
        cleanupGeneration: 1,
        enabled: false,
      });
    }
  );

  it('recovers an ambiguous POST by reading first and repeats the same command only after 404', async () => {
    h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
      h.submitted.push(command);
      if (h.submitted.length === 1) throw cloudError('network_error');
      return statusFor(command);
    });
    const sync = h.service();

    await expect(h.replace(sync)).resolves.toMatchObject({
      applied: false,
      authoritySync: { status: 'pending' },
    });
    const stored = h.db.select().from(connectorManagedAuthorityOutbox).get()!;
    h.clock = Date.parse(stored.nextAttemptAt!) + 1;

    await expect(sync.recoverPending(new AbortController().signal)).resolves.toBe(1);
    expect(h.cloud.readConnectorAuthorityCommand).toHaveBeenCalledWith(
      stored.commandId,
      expect.any(AbortSignal)
    );
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[1]).toEqual(h.submitted[0]);
    expect(h.db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('applied');
  });

  it('cannot let an older delayed acknowledgement replace the latest scope', async () => {
    let releaseFirst!: (status: ManagedConnectorAuthorityCommandStatus) => void;
    h.cloud.submitConnectorAuthorityCommand = (command) => {
      h.submitted.push(command);
      if (h.submitted.length === 1) {
        return new Promise<ManagedConnectorAuthorityCommandStatus>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve(statusFor(command));
    };
    const sync = h.service();

    const first = h.replace(sync);
    await expect(h.replace(sync)).resolves.toMatchObject({ applied: true });
    releaseFirst(statusFor(h.submitted[0]!));
    await expect(first).resolves.toMatchObject({ applied: false });

    const rows = h.db.select().from(connectorManagedAuthorityOutbox).all();
    expect(rows.map((row) => row.state)).toEqual(['superseded', 'applied']);
    expect(h.db.select().from(connectorManagedAuthorityScopes).get()).toMatchObject({
      scopeVersion: 2,
      lastCommandId: h.submitted[1]!.commandId,
    });
  });

  it('refuses a cloud acknowledgement after local provider material changes', async () => {
    let release!: (status: ManagedConnectorAuthorityCommandStatus) => void;
    h.cloud.submitConnectorAuthorityCommand = (command) =>
      new Promise<ManagedConnectorAuthorityCommandStatus>((resolve) => {
        h.submitted.push(command);
        release = resolve;
      });
    const pending = h.replace();
    h.db
      .update(connectorProviderInstances)
      .set({ executionConfigGeneration: 2 })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();

    release(statusFor(h.submitted[0]!));
    await expect(pending).resolves.toMatchObject({ applied: false });
    expect(h.db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('superseded');
  });

  it('persists a safe relink refusal without leaking hosted response details', async () => {
    h.cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
      throw cloudError('permission_upgrade_required', 'secret hosted account and stack trace');
    });

    await expect(h.replace()).resolves.toEqual({
      authoritySync: {
        status: 'failed',
        reason:
          'Your DorkOS account link needs updating. Link this computer again in Settings › DorkOS account.',
      },
      applied: false,
      externalCleanup: 'not_required',
    });
    const row = h.db.select().from(connectorManagedAuthorityOutbox).get()!;
    expect(row).toMatchObject({
      state: 'rejected',
      safeReason:
        'Your DorkOS account link needs updating. Link this computer again in Settings › DorkOS account.',
      nextAttemptAt: null,
    });
    expect(JSON.stringify(row)).not.toContain('secret hosted');
  });

  it('rolls back local closure when the durable lifecycle command cannot append', async () => {
    const sync = new ManagedAuthoritySyncService({
      db: h.db,
      cloud: h.cloud,
      now: () => new Date(h.clock),
      createId: () => 'duplicate-command',
      random: () => 0.5,
    });
    await sync.transition(lifecycleChange('active'));

    await expect(sync.transition(lifecycleChange('paused'))).rejects.toThrow();
    expect(h.db.select().from(connections).get()?.enabled).toBe(true);
  });

  it('never records applied when local grant activation rolls back', async () => {
    h.db.$client.exec(`
      CREATE TRIGGER reject_managed_grant_activation
      BEFORE UPDATE OF revoked_at ON connection_operation_grants
      WHEN NEW.revoked_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'activation refused');
      END;
    `);

    await expect(h.replace()).resolves.toMatchObject({
      applied: false,
      authoritySync: { status: 'pending' },
    });
    expect(h.db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('pending');
    expect(h.db.select().from(connectionOperationGrants).get()?.revokedAt).not.toBeNull();
  });

  it('compacts old terminal payloads while retaining the durable command tombstone', async () => {
    const sync = h.service();
    await h.replace(sync);
    const before = h.db.select().from(connectorManagedAuthorityOutbox).get()!;
    h.clock += 31 * 24 * 60 * 60 * 1_000;

    expect(sync.compactTerminal(new Date(h.clock - 24 * 60 * 60 * 1_000).toISOString())).toBe(1);
    expect(h.db.select().from(connectorManagedAuthorityOutbox).get()).toMatchObject({
      commandId: before.commandId,
      requestHash: before.requestHash,
      scopeVersion: before.scopeVersion,
      requestJson: '{}',
      compactedAt: new Date(h.clock).toISOString(),
    });
    expect(h.db.select().from(connectorManagedAuthorityScopes).get()).toMatchObject({
      lastCommandId: before.commandId,
      lastCommandHash: before.requestHash,
      scopeVersion: before.scopeVersion,
    });
  });

  describe('a disconnect whose hosted sign-out stalls', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function disconnect(sync = h.service()) {
      return sync.transition(lifecycleChange('disconnected'));
    }

    function cleanupStatus(
      command: ManagedConnectorAuthorityCommand,
      externalCleanup: 'pending' | 'complete' | 'failed'
    ): ManagedConnectorAuthorityCommandStatus {
      return { ...statusFor(command), externalCleanup } as ManagedConnectorAuthorityCommandStatus;
    }

    function outbox() {
      return h.db.select().from(connectorManagedAuthorityOutbox).get()!;
    }

    it.each(['background recovery', 'Finish disconnecting'] as const)(
      'sends the same command again through %s until an applied-but-pending cleanup completes',
      async (path) => {
        const cleanup: Array<'pending' | 'complete'> = ['pending', 'pending', 'complete'];
        h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
          h.submitted.push(command);
          return cleanupStatus(command, cleanup.shift()!);
        });
        h.cloud.readConnectorAuthorityCommand = vi.fn(async () =>
          cleanupStatus(h.submitted[0]!, 'pending')
        );
        const sync = h.service();

        await expect(disconnect(sync)).resolves.toMatchObject({ externalCleanup: 'pending' });
        const first = outbox();
        expect(first).toMatchObject({
          state: 'pending',
          safeReason: 'DorkOS’s servers haven’t finished disconnecting this account.',
        });

        // The hosted row reads applied with cleanup pending: reading alone never
        // finishes it, so the exact command goes out again.
        h.clock = Date.parse(first.nextAttemptAt!) + 1;
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
        expect(h.submitted).toHaveLength(2);
        expect(h.submitted[1]).toEqual(h.submitted[0]);
        const second = outbox();
        expect(second.state).toBe('pending');
        // Backoff grows between tries rather than hammering the hosted side.
        expect(Date.parse(second.nextAttemptAt!) - h.clock).toBeGreaterThan(
          Date.parse(first.nextAttemptAt!) - START
        );

        h.clock = Date.parse(second.nextAttemptAt!) + 1;
        await sync.recoverPending(new AbortController().signal);
        expect(h.submitted).toHaveLength(3);
        expect(h.submitted[2]).toEqual(h.submitted[0]);
        expect(outbox()).toMatchObject({ state: 'applied', safeReason: null, nextAttemptAt: null });
        expect(h.db.select().from(connections).get()).toMatchObject({
          externalCleanupState: 'complete',
        });
        expect(h.db.select().from(connectorManagedAuthorityOutbox).all()).toHaveLength(1);
      }
    );

    it('sends a resume the hosted side still holds as pending again until it applies', async () => {
      {
        h.db.update(connections).set({ enabled: false }).run();
        const states: Array<'pending' | 'applied'> = ['pending', 'pending', 'applied'];
        h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
          h.submitted.push(command);
          return statusFor(command, states.shift()!);
        });
        h.cloud.readConnectorAuthorityCommand = vi.fn(async () =>
          statusFor(h.submitted[0]!, 'pending')
        );
        const sync = h.service();
        const resume = () => sync.transition(lifecycleChange('active'));

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
        h.clock = Date.parse(first.nextAttemptAt!) + 1;
        await sync.recoverPending(new AbortController().signal);
        expect(h.submitted).toHaveLength(2);
        expect(h.submitted[1]).toEqual(h.submitted[0]);
        expect(outbox().state).toBe('pending');

        h.clock = Date.parse(outbox().nextAttemptAt!) + 1;
        await sync.recoverPending(new AbortController().signal);
        expect(h.submitted).toHaveLength(3);
        expect(h.submitted[2]).toEqual(h.submitted[0]);
        expect(outbox()).toMatchObject({ state: 'applied', safeReason: null });
        expect(h.db.select().from(connections).get()?.enabled).toBe(true);
      }
    });

    it('does not send again once the hosted read says cleanup settled', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return cleanupStatus(command, 'pending');
      });
      const sync = h.service();
      await disconnect(sync);
      h.cloud.readConnectorAuthorityCommand = vi.fn(async () =>
        cleanupStatus(h.submitted[0]!, 'failed')
      );
      h.clock = Date.parse(outbox().nextAttemptAt!) + 1;
      await sync.recoverPending(new AbortController().signal);
      expect(h.submitted).toHaveLength(1);
      expect(outbox().state).toBe('applied');
      expect(h.db.select().from(connections).get()?.externalCleanupState).toBe('failed');
    });

    it('finishes an account disconnected before cleanup was tracked (unknown) through the same path', async () => {
      h.db
        .update(connections)
        .set({ lifecycleState: 'disconnected', enabled: false, externalCleanupState: 'unknown' })
        .run();
      const cleanup: Array<'pending' | 'complete'> = ['pending', 'complete'];
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return cleanupStatus(command, cleanup.shift()!);
      });
      h.cloud.readConnectorAuthorityCommand = vi.fn(async () =>
        cleanupStatus(h.submitted[0]!, 'pending')
      );
      const sync = h.service();

      await disconnect(sync);
      expect(h.db.select().from(connections).get()?.externalCleanupState).toBe('pending');
      h.clock = Date.parse(outbox().nextAttemptAt!) + 1;
      await sync.recoverPending(new AbortController().signal);

      expect(h.submitted).toHaveLength(2);
      expect(h.submitted[1]).toEqual(h.submitted[0]);
      expect(h.db.select().from(connections).get()?.externalCleanupState).toBe('complete');
    });

    it('gives up on a hung hosted request so recovery keeps running', async () => {
      const deadlines: AbortController[] = [];
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return cleanupStatus(command, 'pending');
      });
      const hang = vi.fn(
        (_id: string, signal?: AbortSignal) =>
          new Promise<ManagedConnectorAuthorityCommandStatus>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason));
          })
      );
      h.cloud.readConnectorAuthorityCommand = hang;
      const sync = new ManagedAuthoritySyncService({
        db: h.db,
        cloud: h.cloud,
        now: () => new Date(h.clock),
        createId: () => `managed-command-${++h.ids}`,
        random: () => 0.5,
        timeoutSignal: (timeoutMs) => {
          expect(timeoutMs).toBe(30_000);
          const deadline = new AbortController();
          deadlines.push(deadline);
          return deadline.signal;
        },
      });
      await disconnect(sync);
      h.clock = Date.parse(outbox().nextAttemptAt!) + 1;

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
      h.cloud.readConnectorAuthorityCommand = vi.fn(async () =>
        cleanupStatus(h.submitted[0]!, 'complete')
      );
      h.clock = Date.parse(outbox().nextAttemptAt!) + 1;
      await expect(sync.recoverPending(new AbortController().signal)).resolves.toBe(1);
      expect(h.db.select().from(connections).get()?.externalCleanupState).toBe('complete');
    });
  });
});

/**
 * @vitest-environment node
 */

import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorEventCapability } from '@dorkos/shared/connector-events';

import * as schema from '@/db/schema';
import {
  applyManagedAuthorityCommand,
  managedRequestHash,
  registerManagedProvider,
  resolveConnectorTenant,
  type ManagedConnectorDatabase,
} from '../../authority-service';
import {
  recoverManagedEventCleanup,
  type ManagedCleanupProvider,
} from '../../event-cleanup-service';
import { provisionManagedTestDatabase } from '../../__tests__/managed-database-fixture';
import { endRevokedInstanceConnections, sweepRevokedInstances } from '../cleanup';
import { endOwnerConnectionsBeforeErasure } from '../erasure';
import { countRevokedInstanceOrphans, runRevokedInstanceOrphanCleanup } from '../orphans';
import { REVOKED_INSTANCE_CONNECTION_GRACE_MS, revokedInstanceConnectionsDue } from '../policy';

// Booting PGlite and replaying the managed migrations costs seconds per case,
// paid in `beforeEach`; the sibling managed suites measured the same 5-15s band
// under load (DOR-1886), so both budgets move to 30s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const definition = {
  eventType: 'GMAIL_NEW_GMAIL_MESSAGE',
  displayName: 'New email',
  toolkit: 'gmail',
  toolkitVersion: '20260901_00',
  definitionHash: `sha256:${'a'.repeat(64)}`,
  filterSchema: { type: 'object', properties: {} },
  payloadSchema: {},
  deliveryMode: 'webhook' as const,
  expectedCadenceSeconds: null,
};

const c = schema.managedConnectorConnection;
const k = schema.managedConnectorAuthorityCommand;

describe('ending a revoked instance’s managed connections', () => {
  let client: PGlite;
  let db: ManagedConnectorDatabase;

  beforeEach(async () => {
    client = new PGlite();
    await provisionManagedTestDatabase(client);
    db = drizzle(client, { schema }) as unknown as ManagedConnectorDatabase;
  });

  afterEach(async () => {
    await client.close();
  });

  /** One active connection with a grant and a live event subscription, for one instance. */
  async function seedInstance(ownerId: string, instanceId: string, suffix: string) {
    const tenant = await resolveConnectorTenant(db, ownerId);
    const generation = await registerManagedProvider(db, {
      tenantId: tenant.id,
      providerInstanceId: 'managed:composio',
      configurationDigest: 'digest',
    });
    const connectionId = `gmail-${suffix}`;
    const accountRef = `ca_${suffix}`;
    await db.insert(c).values({
      tenantId: tenant.id,
      id: connectionId,
      originatingInstanceId: instanceId,
      providerInstanceId: 'managed:composio',
      providerUserId: tenant.providerUserId,
      externalAccountRef: accountRef,
      toolkit: 'gmail',
      authConfigId: 'ac_gmail',
      label: 'Email',
      lifecycle: 'active',
      authenticationStatus: 'active',
      materialGeneration: generation,
    });
    const [revision] = await db
      .insert(schema.managedConnectorOperationRevision)
      .values({
        tenantId: tenant.id,
        providerInstanceId: 'managed:composio',
        toolkit: 'gmail',
        operationSlug: `gmail.messages.list.${suffix}`,
        toolkitVersion: '20260901_00',
        schemaHash: `sha256:${suffix}`,
        classification: 'read',
        inputSchema: { type: 'object' },
      })
      .returning();
    await db.insert(schema.managedConnectorGrant).values({
      tenantId: tenant.id,
      instanceId,
      connectionId,
      agentId: 'agent',
      operationRevisionId: revision.id,
      scopeVersion: 1,
      active: true,
    });
    let [eventDefinition] = await db
      .select()
      .from(schema.managedConnectorEventDefinition)
      .where(eq(schema.managedConnectorEventDefinition.tenantId, tenant.id));
    eventDefinition ??= (
      await db
        .insert(schema.managedConnectorEventDefinition)
        .values({
          tenantId: tenant.id,
          providerInstanceId: 'managed:composio',
          toolkit: 'gmail',
          eventType: definition.eventType,
          definitionHash: definition.definitionHash,
          definition,
        })
        .returning()
    )[0];
    const [binding] = await db
      .insert(schema.managedConnectorEventBinding)
      .values({
        tenantId: tenant.id,
        providerInstanceId: 'managed:composio',
        providerGeneration: generation,
        externalAccountRef: accountRef,
        definitionId: eventDefinition.id,
        filterHash: managedRequestHash({}),
        filter: {},
        providerTriggerRef: `tr_${suffix}`,
        providerTriggerUuid: `trigger-uuid-${suffix}`,
        state: 'ready',
      })
      .returning();
    await db.insert(schema.managedConnectorEventSubscription).values({
      tenantId: tenant.id,
      id: `subscription-${suffix}`,
      connectionId,
      targetInstanceId: instanceId,
      bindingId: binding.id,
      agentId: 'agent',
      destinationKind: 'agent',
      destinationId: 'agent',
      scopeVersion: 1,
      connectionGeneration: 1,
      enabled: true,
    });
    return { tenant, connectionId, accountRef, binding };
  }

  /** A provider seam whose calls land in one ordered log. */
  function fakeService(tenantProviderUserId?: string) {
    const calls: string[] = [];
    const deleteAccount = vi.fn(async (ref: string) => {
      calls.push(`account:${ref}`);
    });
    const events = {
      listDefinitions: vi.fn(),
      createTrigger: vi.fn(),
      setTriggerEnabled: vi.fn(),
      verifyWebhook: vi.fn(),
      reconcileTrigger: vi.fn<ConnectorEventCapability['reconcileTrigger']>(async (input) => ({
        status: 'found',
        trigger: {
          providerTriggerRef: `tr_${input.externalAccountRef.slice(3)}`,
          providerTriggerUuid: `trigger-uuid-${input.externalAccountRef.slice(3)}`,
          externalAccountRef: input.externalAccountRef,
          enabled: true,
        },
      })),
      deleteTrigger: vi.fn<ConnectorEventCapability['deleteTrigger']>(async (input) => {
        if (!(await input.authorizeDispatch()))
          return { status: 'denied', code: 'AUTHORITY_CHANGED' };
        calls.push(`trigger:${input.providerTriggerRef}`);
        return { status: 'ok' };
      }),
    } as unknown as ConnectorEventCapability;
    const resolveProvider: ManagedCleanupProvider = (providerUserId) => {
      if (tenantProviderUserId) expect(providerUserId).toBe(tenantProviderUserId);
      return {
        events,
        executionConfigDigest: 'digest',
        accounts: {
          getAccount: vi.fn(),
          deleteAccount,
        },
      };
    };
    return { calls, deleteAccount, events, resolveProvider };
  }

  /** Revoke as `revokeInstance` does: the app's clock stamps the row and the key goes. */
  async function revoke(instanceId: string) {
    await db
      .update(schema.instance)
      .set({ revokedAt: new Date() })
      .where(eq(schema.instance.id, instanceId));
    await client.query(`DELETE FROM apikey WHERE metadata::jsonb ->> 'instanceId' = $1`, [
      instanceId,
    ]);
  }

  async function connectionOf(connectionId: string) {
    const [row] = await db.select().from(c).where(eq(c.id, connectionId));
    return row;
  }

  async function rowsFor(instanceId: string) {
    return {
      grants: await db
        .select()
        .from(schema.managedConnectorGrant)
        .where(eq(schema.managedConnectorGrant.instanceId, instanceId)),
      subscriptions: await db
        .select()
        .from(schema.managedConnectorEventSubscription)
        .where(eq(schema.managedConnectorEventSubscription.targetInstanceId, instanceId)),
      commands: await db.select().from(k).where(eq(k.instanceId, instanceId)),
    };
  }

  it('ends every sign-in at the service when a link is revoked: triggers first, then the account', async () => {
    const mine = await seedInstance('owner-a', 'instance-a', 'a');
    const sibling = await seedInstance('owner-a', 'instance-c', 'c');
    const other = await seedInstance('owner-b', 'instance-b', 'b');
    const service = fakeService(mine.tenant.providerUserId);
    await revoke('instance-a');

    await endRevokedInstanceConnections(db, 'instance-a', {
      signal: new AbortController().signal,
      resolveProvider: service.resolveProvider,
    });

    expect(service.calls).toEqual(['trigger:tr_a', 'account:ca_a']);
    expect(await connectionOf(mine.connectionId)).toMatchObject({ lifecycle: 'disconnected' });
    const after = await rowsFor('instance-a');
    expect(after.grants).toEqual([
      expect.objectContaining({ active: false, revokedAt: expect.any(Date) }),
    ]);
    expect(after.subscriptions).toEqual([
      expect.objectContaining({ enabled: false, scopeVersion: 2, revokedAt: expect.any(Date) }),
    ]);
    expect(after.commands.map((row) => [row.kind, row.state, row.externalCleanup]).sort()).toEqual([
      ['set_connection_lifecycle', 'applied', 'complete'],
      ['set_event_subscription', 'applied', 'complete'],
    ]);
    const [retired] = await db
      .select()
      .from(schema.managedConnectorEventBinding)
      .where(eq(schema.managedConnectorEventBinding.id, mine.binding.id));
    expect(retired.state).toBe('retired');

    // The same owner's other machine and another owner are untouched.
    for (const untouched of [sibling, other]) {
      expect(await connectionOf(untouched.connectionId)).toMatchObject({ lifecycle: 'active' });
    }
    for (const instanceId of ['instance-c', 'instance-b']) {
      const rows = await rowsFor(instanceId);
      expect(rows.grants.every((grant) => grant.active)).toBe(true);
      expect(rows.subscriptions.every((subscription) => subscription.enabled)).toBe(true);
      expect(rows.commands).toEqual([]);
    }
  });

  it('changes nothing and calls the service no more when run again', async () => {
    await seedInstance('owner-a', 'instance-a', 'a');
    const service = fakeService();
    await revoke('instance-a');
    const options = {
      signal: new AbortController().signal,
      resolveProvider: service.resolveProvider,
    };
    await endRevokedInstanceConnections(db, 'instance-a', options);
    const settled = await rowsFor('instance-a');

    await endRevokedInstanceConnections(db, 'instance-a', options);
    expect(await sweepRevokedInstances(db, options)).toEqual({
      instancesClosed: 0,
      accountsExamined: 0,
      accountsCompleted: 0,
    });
    expect(service.calls).toEqual(['trigger:tr_a', 'account:ca_a']);
    expect(await rowsFor('instance-a')).toEqual(settled);
  });

  it('never touches a live instance', async () => {
    const mine = await seedInstance('owner-a', 'instance-a', 'a');
    const service = fakeService();
    const before = await rowsFor('instance-a');
    await endRevokedInstanceConnections(db, 'instance-a', {
      signal: new AbortController().signal,
      resolveProvider: service.resolveProvider,
    });
    expect(await sweepRevokedInstances(db, { signal: new AbortController().signal })).toEqual({
      instancesClosed: 0,
      accountsExamined: 0,
      accountsCompleted: 0,
    });
    expect(service.calls).toEqual([]);
    expect(await connectionOf(mine.connectionId)).toMatchObject({ lifecycle: 'active' });
    expect(await rowsFor('instance-a')).toEqual(before);
  });

  it('closes at once even when the service cannot be reached, and the sweep finishes later', async () => {
    const mine = await seedInstance('owner-a', 'instance-a', 'a');
    await revoke('instance-a');
    await endRevokedInstanceConnections(db, 'instance-a', {
      signal: new AbortController().signal,
      resolveProvider: () => undefined,
    });
    // Closed and owed: nothing can use it, and the deletion is still on record.
    expect(await connectionOf(mine.connectionId)).toMatchObject({ lifecycle: 'disconnected' });
    expect((await rowsFor('instance-a')).grants[0].active).toBe(false);
    expect(await countRevokedInstanceOrphans(db)).toEqual({
      instances: 1,
      openConnections: 0,
      openSubscriptions: 0,
      accountsOwed: 1,
    });

    const service = fakeService();
    const signal = new AbortController().signal;
    // The failed attempt scheduled the trigger's retry 30 seconds out.
    await recoverManagedEventCleanup(
      db,
      signal,
      service.resolveProvider,
      25,
      () => new Date(Date.now() + 31_000)
    );
    expect(
      await sweepRevokedInstances(db, { signal, resolveProvider: service.resolveProvider })
    ).toEqual({
      instancesClosed: 0,
      accountsExamined: 1,
      accountsCompleted: 1,
    });
    expect(service.calls).toEqual(['trigger:tr_a', 'account:ca_a']);
    expect(await countRevokedInstanceOrphans(db)).toEqual({
      instances: 0,
      openConnections: 0,
      openSubscriptions: 0,
      accountsOwed: 0,
    });
  });

  it('retries a failed account deletion through the same leased cleanup', async () => {
    await seedInstance('owner-a', 'instance-a', 'a');
    const service = fakeService();
    service.deleteAccount.mockRejectedValueOnce(new Error('service unavailable'));
    await revoke('instance-a');
    const options = {
      signal: new AbortController().signal,
      resolveProvider: service.resolveProvider,
    };
    await endRevokedInstanceConnections(db, 'instance-a', options);
    const [failed] = (await rowsFor('instance-a')).commands.filter(
      (row) => row.kind === 'set_connection_lifecycle'
    );
    expect(failed).toMatchObject({ externalCleanup: 'failed', cleanupClaimedAt: null });

    expect(await sweepRevokedInstances(db, options)).toMatchObject({ accountsCompleted: 1 });
    expect(service.deleteAccount).toHaveBeenCalledTimes(2);
  });

  it('closes an instance revoked by any other path from the sweep', async () => {
    const mine = await seedInstance('owner-a', 'instance-a', 'a');
    await seedInstance('owner-a', 'instance-c', 'c');
    await revoke('instance-a');
    const service = fakeService();
    const signal = new AbortController().signal;

    expect(
      await sweepRevokedInstances(db, { signal, resolveProvider: service.resolveProvider })
    ).toEqual({
      instancesClosed: 1,
      accountsExamined: 1,
      accountsCompleted: 1,
    });
    expect(await connectionOf(mine.connectionId)).toMatchObject({ lifecycle: 'disconnected' });
    expect(await connectionOf('gmail-c')).toMatchObject({ lifecycle: 'active' });
    expect(service.deleteAccount).toHaveBeenCalledWith('ca_a', signal);
    expect(service.deleteAccount).toHaveBeenCalledTimes(1);
  });

  it('keeps a disconnect the instance made itself, and finishes its owed cleanup after the revoke', async () => {
    const seeded = await seedInstance('owner-a', 'instance-a', 'a');
    const principal = {
      ownerId: 'owner-a',
      instanceId: 'instance-a',
      tenantId: seeded.tenant.id,
      keyId: 'key-a',
    };
    // A disconnect with no provider material stays owed, as when the service was down.
    await expect(
      applyManagedAuthorityCommand(db, principal, {
        version: 1,
        kind: 'set_connection_lifecycle',
        commandId: 'own-disconnect',
        managedConnectionId: seeded.connectionId,
        scopeVersion: 2,
        lifecycle: 'disconnected',
      })
    ).rejects.toMatchObject({ name: 'ManagedAuthorityProviderUnavailableError' });
    await revoke('instance-a');
    const service = fakeService();

    await endRevokedInstanceConnections(db, 'instance-a', {
      signal: new AbortController().signal,
      resolveProvider: service.resolveProvider,
    });
    const lifecycle = (await rowsFor('instance-a')).commands.filter(
      (row) => row.kind === 'set_connection_lifecycle'
    );
    expect(lifecycle).toEqual([
      expect.objectContaining({ commandId: 'own-disconnect', externalCleanup: 'complete' }),
    ]);
    expect(service.deleteAccount).toHaveBeenCalledTimes(1);
  });

  it('finishes trigger cleanup a revoked instance owes, with no key to act under', async () => {
    const seeded = await seedInstance('owner-a', 'instance-a', 'a');
    const principal = {
      ownerId: 'owner-a',
      instanceId: 'instance-a',
      tenantId: seeded.tenant.id,
      keyId: 'key-a',
    };
    const [subscription] = (await rowsFor('instance-a')).subscriptions;
    expect(
      (
        await applyManagedAuthorityCommand(db, principal, {
          version: 1,
          kind: 'set_event_subscription',
          commandId: 'own-disable',
          managedConnectionId: seeded.connectionId,
          scopeVersion: 1,
          subscriptionId: subscription.id,
          subscriptionVersion: 2,
          hostedDefinitionId: seeded.binding.definitionId,
          agentId: 'agent',
          destination: { kind: 'agent', id: 'agent' },
          filter: {},
          enabled: false,
        })
      ).status
    ).toMatchObject({ state: 'applied', externalCleanup: 'pending' });
    await revoke('instance-a');
    const service = fakeService();

    expect(
      await recoverManagedEventCleanup(db, new AbortController().signal, service.resolveProvider)
    ).toEqual({ examined: 1, completed: 1 });
    expect(service.calls).toEqual(['trigger:tr_a']);
  });

  it('ends the connections due at once: there is no grace period today', () => {
    expect(REVOKED_INSTANCE_CONNECTION_GRACE_MS).toBe(0);
    const revokedAt = new Date('2026-09-28T12:00:00.000Z');
    expect(revokedInstanceConnectionsDue(revokedAt, revokedAt)).toBe(true);
    expect(revokedInstanceConnectionsDue(revokedAt, new Date(revokedAt.getTime() - 1))).toBe(false);
  });

  describe('before an account is erased', () => {
    it('revokes every instance, ends every sign-in, and reports none left', async () => {
      await seedInstance('owner-a', 'instance-a', 'a');
      await seedInstance('owner-a', 'instance-c', 'c');
      const other = await seedInstance('owner-b', 'instance-b', 'b');
      const service = fakeService();

      expect(
        await endOwnerConnectionsBeforeErasure(db, 'owner-a', {
          signal: new AbortController().signal,
          resolveProvider: service.resolveProvider,
        })
      ).toBe(0);
      expect(service.deleteAccount.mock.calls.map(([ref]) => ref).sort()).toEqual(['ca_a', 'ca_c']);
      const instances = await db
        .select()
        .from(schema.instance)
        .where(eq(schema.instance.userId, 'owner-a'));
      expect(instances.every((row) => row.revokedAt !== null)).toBe(true);
      expect(await connectionOf(other.connectionId)).toMatchObject({ lifecycle: 'active' });
    });

    it('reports a sign-in still live at the service, so the erasure can be refused', async () => {
      await seedInstance('owner-a', 'instance-a', 'a');
      const service = fakeService();
      service.deleteAccount.mockRejectedValue(new Error('service unavailable'));

      expect(
        await endOwnerConnectionsBeforeErasure(db, 'owner-a', {
          signal: new AbortController().signal,
          resolveProvider: service.resolveProvider,
        })
      ).toBe(1);
      // The record survives, so a later attempt can still finish it.
      const [owed] = await db
        .select()
        .from(k)
        .where(and(eq(k.instanceId, 'instance-a'), eq(k.kind, 'set_connection_lifecycle')));
      expect(owed).toMatchObject({ externalCleanup: 'failed' });
    });
  });

  describe('the one-off for connections past revokes left behind', () => {
    it('only counts by default, and ends them with clean', async () => {
      await seedInstance('owner-a', 'instance-a', 'a');
      await seedInstance('owner-b', 'instance-b', 'b');
      await revoke('instance-a');
      const service = fakeService();
      const lines: string[] = [];
      const options = {
        signal: new AbortController().signal,
        resolveProvider: service.resolveProvider,
        print: (line: string) => lines.push(line),
      };
      const orphaned = {
        instances: 1,
        openConnections: 1,
        openSubscriptions: 1,
        accountsOwed: 0,
      };

      expect(await runRevokedInstanceOrphanCleanup(db, { ...options, clean: false })).toEqual({
        before: orphaned,
      });
      expect(service.calls).toEqual([]);
      expect(await countRevokedInstanceOrphans(db)).toEqual(orphaned);
      expect(lines.at(-1)).toContain('nothing was changed');

      expect(await runRevokedInstanceOrphanCleanup(db, { ...options, clean: true })).toEqual({
        before: orphaned,
        after: { instances: 0, openConnections: 0, openSubscriptions: 0, accountsOwed: 0 },
      });
      expect(service.calls).toEqual(['trigger:tr_a', 'account:ca_a']);
      expect(await connectionOf('gmail-b')).toMatchObject({ lifecycle: 'active' });
    });
  });
});

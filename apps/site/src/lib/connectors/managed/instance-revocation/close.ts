/**
 * The close step: in one transaction under a lock on the revoked instance row,
 * disconnect every connection the instance created through the same durable
 * `set_connection_lifecycle` receipt the instance would have sent, revoke every
 * grant it holds, turn off every event subscription it targets through a
 * `set_event_subscription` receipt, and supersede any command still pending
 * for it (its key is gone, so it can never finish). Nothing here calls the
 * service; the receipts it writes are what the cleanup step then finishes.
 *
 * @module lib/connectors/managed/instance-revocation/close
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import {
  ManagedConnectorAuthorityCommandSchema,
  type ManagedConnectorAuthorityCommand,
} from '@dorkos/shared/connector-managed-schemas';

import { schema } from '@/db/client';
import { managedRequestHash, type ManagedConnectorDatabase } from '../authority-service';
import { revokedInstanceConnectionsDue } from './policy';

type Transaction = Parameters<Parameters<ManagedConnectorDatabase['transaction']>[0]>[0];
type EventCommand = Extract<ManagedConnectorAuthorityCommand, { kind: 'set_event_subscription' }>;

const commands = schema.managedConnectorAuthorityCommand;
const connections = schema.managedConnectorConnection;
const subscriptions = schema.managedConnectorEventSubscription;
const bindings = schema.managedConnectorEventBinding;
const tenants = schema.connectorTenant;

/** Revoked instance identity the close step works under. */
interface RevokedInstance {
  id: string;
  userId: string;
}

/** Store one command the service writes on a revoked instance's behalf. */
async function insertServiceCommand(
  tx: Transaction,
  tenantId: string,
  instanceId: string,
  command: ManagedConnectorAuthorityCommand,
  values: Pick<
    typeof commands.$inferInsert,
    'scopeKey' | 'agentId' | 'cleanupBinding' | 'eventBindingId' | 'appliedEventScopeHash'
  >
): Promise<void> {
  const parsed = ManagedConnectorAuthorityCommandSchema.parse(command);
  await tx.insert(commands).values({
    tenantId,
    instanceId,
    commandId: parsed.commandId,
    requestHash: managedRequestHash(parsed),
    connectionId: parsed.managedConnectionId,
    kind: parsed.kind,
    scopeVersion: parsed.scopeVersion,
    requestPayload: parsed as unknown as Record<string, unknown>,
    state: 'applied',
    externalCleanup: 'pending',
    ...values,
  });
}

/** The next free scope version for one command scope on one connection. */
async function nextScopeVersion(
  tx: Transaction,
  tenantId: string,
  instanceId: string,
  connectionId: string,
  scopeKey: string,
  floor: number
): Promise<number> {
  const [latest] = await tx
    .select({ scopeVersion: commands.scopeVersion })
    .from(commands)
    .where(
      and(
        eq(commands.tenantId, tenantId),
        eq(commands.instanceId, instanceId),
        eq(commands.connectionId, connectionId),
        eq(commands.scopeKey, scopeKey)
      )
    )
    .orderBy(desc(commands.scopeVersion))
    .limit(1);
  return Math.max(latest?.scopeVersion ?? 0, floor) + 1;
}

/**
 * Close everything a revoked instance still holds open, inside the caller's
 * transaction (which already holds the instance row). Returns how many
 * connections and subscriptions it closed.
 */
async function closeInstanceConnections(
  tx: Transaction,
  instance: RevokedInstance,
  now: Date
): Promise<number> {
  const ownTenant = and(
    eq(tenants.id, connections.tenantId),
    eq(tenants.ownerUserId, instance.userId)
  );
  // Nothing pending can finish: its key is gone. Supersede it before anything
  // else, so no pending resume or event setup outlives the close.
  await tx
    .update(commands)
    .set({ state: 'superseded', updatedAt: now })
    .where(and(eq(commands.instanceId, instance.id), eq(commands.state, 'pending')));

  const open = await tx
    .select({ connection: connections })
    .from(connections)
    .innerJoin(tenants, ownTenant)
    .where(
      and(
        eq(connections.originatingInstanceId, instance.id),
        ne(connections.lifecycle, 'disconnected')
      )
    )
    .for('update');
  for (const { connection } of open) {
    const scopeVersion = await nextScopeVersion(
      tx,
      connection.tenantId,
      instance.id,
      connection.id,
      'lifecycle',
      connection.lifecycleScopeVersion
    );
    await insertServiceCommand(
      tx,
      connection.tenantId,
      instance.id,
      {
        version: 1,
        kind: 'set_connection_lifecycle',
        commandId: `instance-revoked-${randomUUID()}`,
        managedConnectionId: connection.id,
        scopeVersion,
        lifecycle: 'disconnected',
      },
      {
        scopeKey: 'lifecycle',
        agentId: null,
        eventBindingId: null,
        appliedEventScopeHash: null,
        cleanupBinding: {
          providerInstanceId: connection.providerInstanceId,
          providerUserId: connection.providerUserId,
          externalAccountRef: connection.externalAccountRef,
          bindingGeneration: connection.bindingGeneration,
          materialGeneration: connection.materialGeneration,
        },
      }
    );
    await tx
      .update(connections)
      .set({ lifecycle: 'disconnected', lifecycleScopeVersion: scopeVersion, updatedAt: now })
      .where(and(eq(connections.tenantId, connection.tenantId), eq(connections.id, connection.id)));
  }

  await tx
    .update(schema.managedConnectorGrant)
    .set({ active: false, revokedAt: now })
    .where(
      and(
        eq(schema.managedConnectorGrant.instanceId, instance.id),
        eq(schema.managedConnectorGrant.active, true)
      )
    );

  const live = await tx
    .select({ subscription: subscriptions, binding: bindings })
    .from(subscriptions)
    .innerJoin(
      bindings,
      and(eq(bindings.tenantId, subscriptions.tenantId), eq(bindings.id, subscriptions.bindingId))
    )
    .innerJoin(
      tenants,
      and(eq(tenants.id, subscriptions.tenantId), eq(tenants.ownerUserId, instance.userId))
    )
    .where(and(eq(subscriptions.targetInstanceId, instance.id), isNull(subscriptions.revokedAt)))
    .for('update');
  for (const { subscription, binding } of live) {
    const scopeKey = `event:${subscription.id}`;
    const scopeVersion = await nextScopeVersion(
      tx,
      subscription.tenantId,
      instance.id,
      subscription.connectionId,
      scopeKey,
      0
    );
    const command: ManagedConnectorAuthorityCommand = {
      version: 1,
      kind: 'set_event_subscription',
      commandId: `instance-revoked-${randomUUID()}`,
      managedConnectionId: subscription.connectionId,
      scopeVersion,
      subscriptionId: subscription.id,
      subscriptionVersion: subscription.scopeVersion + 1,
      hostedDefinitionId: binding.definitionId,
      agentId: subscription.agentId,
      destination: { kind: subscription.destinationKind, id: subscription.destinationId },
      // Stored from a parsed command, and parsed again before it is written.
      filter: binding.filter as EventCommand['filter'],
      enabled: false,
    };
    await insertServiceCommand(tx, subscription.tenantId, instance.id, command, {
      scopeKey,
      agentId: subscription.agentId,
      cleanupBinding: null,
      eventBindingId: binding.id,
      appliedEventScopeHash: managedRequestHash(command),
    });
    await tx
      .update(subscriptions)
      .set({
        enabled: false,
        scopeVersion: subscription.scopeVersion + 1,
        revokedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(subscriptions.tenantId, subscription.tenantId),
          eq(subscriptions.id, subscription.id)
        )
      );
  }
  return open.length + live.length;
}

/**
 * Close one revoked instance's connections, grants and subscriptions, once the
 * grace policy says they are due. Returns how many it closed (0 when the
 * instance is not revoked, is not yet due, or had nothing open).
 *
 * @param db - The site database.
 * @param instanceId - The revoked instance.
 * @param now - The current time.
 * @param policy - `ignoreGrace` for an account erasure, which never waits.
 */
export async function closeRevokedInstance(
  db: ManagedConnectorDatabase,
  instanceId: string,
  now: Date,
  policy: { ignoreGrace?: boolean } = {}
): Promise<number> {
  return db.transaction(async (tx) => {
    const [instance] = await tx
      .select({
        id: schema.instance.id,
        userId: schema.instance.userId,
        revokedAt: schema.instance.revokedAt,
      })
      .from(schema.instance)
      .where(and(eq(schema.instance.id, instanceId), isNotNull(schema.instance.revokedAt)))
      .for('update');
    if (!instance?.revokedAt) return 0;
    if (!policy.ignoreGrace && !revokedInstanceConnectionsDue(instance.revokedAt, now)) return 0;
    return closeInstanceConnections(tx, instance, now);
  });
}

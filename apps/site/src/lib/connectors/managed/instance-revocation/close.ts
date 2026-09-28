/**
 * The close step: in one transaction under a lock on the revoked instance row,
 * disconnect every connection the instance created through the same durable
 * `set_connection_lifecycle` receipt the instance would have sent, revoke every
 * grant it holds, turn off every event subscription it targets through a
 * `set_event_subscription` receipt, and supersede any command still pending
 * for it (its key is gone, so it can never finish). Nothing here calls the
 * service; the receipts it writes are what the cleanup step then finishes.
 *
 * A connection that is already disconnected but whose account deletion is
 * neither done nor owed (its disconnect receipt was superseded, or never
 * written) gets a fresh receipt too, so every closed connection ends with its
 * provider account either deleted or on record as owed.
 *
 * @module lib/connectors/managed/instance-revocation/close
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
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

/**
 * SQL over one connection row (named by `row`, a table or alias) that is true
 * when its provider account is already deleted: a complete disconnect receipt
 * exists for its exact binding.
 *
 * @param row - The connection table name or alias the fragment reads.
 */
export function accountDeletionDone(row = 'managed_connector_connection'): SQL {
  const c = sql.raw(row);
  return sql`EXISTS (
    SELECT 1 FROM managed_connector_authority_command k
    WHERE k.tenant_id = ${c}.tenant_id AND k.instance_id = ${c}.originating_instance_id
      AND k.connection_id = ${c}.id AND k.kind = 'set_connection_lifecycle' AND k.state = 'applied'
      AND k.external_cleanup = 'complete'
      AND k.cleanup_binding ->> 'externalAccountRef' = ${c}.external_account_ref
      AND (k.cleanup_binding ->> 'bindingGeneration')::int = ${c}.binding_generation
  )`;
}

/**
 * SQL over one connection row that is true when its account deletion is on
 * record as owed: a pending or failed disconnect receipt for its exact binding
 * at its current lifecycle scope, which the cleanup step can still claim.
 *
 * @param row - The connection table name or alias the fragment reads.
 */
export function accountDeletionOwed(row = 'managed_connector_connection'): SQL {
  const c = sql.raw(row);
  return sql`EXISTS (
    SELECT 1 FROM managed_connector_authority_command k
    WHERE k.tenant_id = ${c}.tenant_id AND k.instance_id = ${c}.originating_instance_id
      AND k.connection_id = ${c}.id AND k.kind = 'set_connection_lifecycle' AND k.state = 'applied'
      AND k.external_cleanup IN ('pending', 'failed') AND k.cleanup_binding IS NOT NULL
      AND k.cleanup_binding ->> 'externalAccountRef' = ${c}.external_account_ref
      AND (k.cleanup_binding ->> 'bindingGeneration')::int = ${c}.binding_generation
      AND k.scope_version = ${c}.lifecycle_scope_version
  )`;
}

/**
 * SQL over one connection row that is true when the close step still has work
 * on it: it is open, or it is closed with its account deletion neither done
 * nor owed.
 *
 * @param row - The connection table name or alias the fragment reads.
 */
export function connectionNeedsClose(row = 'managed_connector_connection'): SQL {
  const c = sql.raw(row);
  return sql`(${c}.lifecycle <> 'disconnected' OR NOT (${accountDeletionDone(row)} OR ${accountDeletionOwed(row)}))`;
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
 * Close connections and revoke grants. All or nothing: it runs in its own
 * savepoint, and a failure fails the whole close.
 */
async function closeConnections(
  tx: Transaction,
  instance: RevokedInstance,
  now: Date
): Promise<number> {
  // Nothing pending can finish: its key is gone. Supersede it before anything
  // else, so no pending resume or event setup outlives the close.
  await tx
    .update(commands)
    .set({ state: 'superseded', updatedAt: now })
    .where(and(eq(commands.instanceId, instance.id), eq(commands.state, 'pending')));

  const open = await tx
    .select({ connection: connections })
    .from(connections)
    .innerJoin(
      tenants,
      and(eq(tenants.id, connections.tenantId), eq(tenants.ownerUserId, instance.userId))
    )
    .where(and(eq(connections.originatingInstanceId, instance.id), connectionNeedsClose()))
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
  return open.length;
}

/** Turn off one live subscription through a disable receipt. */
async function closeSubscription(
  tx: Transaction,
  instance: RevokedInstance,
  subscription: typeof subscriptions.$inferSelect,
  binding: typeof bindings.$inferSelect,
  now: Date
): Promise<void> {
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
      and(eq(subscriptions.tenantId, subscription.tenantId), eq(subscriptions.id, subscription.id))
    );
}

/**
 * Close everything a revoked instance still holds open, inside the caller's
 * transaction (which already holds the instance row). Connections and grants
 * close first in their own savepoint; each subscription then closes in a
 * savepoint of its own, so one that cannot be closed never undoes the rest.
 * A subscription that fails is stamped as just tried, which moves its
 * instance to the back of the sweep's queue.
 */
async function closeInstanceConnections(
  tx: Transaction,
  instance: RevokedInstance,
  now: Date
): Promise<{ connections: number; subscriptions: number; failed: number }> {
  const closedConnections = await tx.transaction((savepoint) =>
    closeConnections(savepoint, instance, now)
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
  let closedSubscriptions = 0;
  let failed = 0;
  for (const { subscription, binding } of live) {
    try {
      await tx.transaction((savepoint) =>
        closeSubscription(savepoint, instance, subscription, binding, now)
      );
      closedSubscriptions++;
    } catch {
      failed++;
      await tx
        .update(subscriptions)
        .set({ updatedAt: now })
        .where(
          and(
            eq(subscriptions.tenantId, subscription.tenantId),
            eq(subscriptions.id, subscription.id)
          )
        );
    }
  }
  return { connections: closedConnections, subscriptions: closedSubscriptions, failed };
}

/**
 * Close one revoked instance's connections, grants and subscriptions, once the
 * grace policy says they are due. Returns how many connections and
 * subscriptions it closed and how many subscriptions it could not (all 0 when
 * the instance is not revoked, is not yet due, or had nothing open).
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
): Promise<{ connections: number; subscriptions: number; failed: number }> {
  const nothing = { connections: 0, subscriptions: 0, failed: 0 };
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
    if (!instance?.revokedAt) return nothing;
    if (!policy.ignoreGrace && !revokedInstanceConnectionsDue(instance.revokedAt, now))
      return nothing;
    return closeInstanceConnections(tx, instance, now);
  });
}

/**
 * Stamp everything a revoked instance still has unclosed (its connections and
 * its live subscriptions) as just tried, after a close that failed as a
 * whole, so the sweep moves on to other instances first.
 *
 * @param db - The site database.
 * @param instanceId - The instance whose close failed.
 * @param now - The current time.
 */
export async function markCloseAttempted(
  db: ManagedConnectorDatabase,
  instanceId: string,
  now: Date
): Promise<void> {
  await db
    .update(connections)
    .set({ updatedAt: now })
    .where(and(eq(connections.originatingInstanceId, instanceId), connectionNeedsClose()));
  await db
    .update(subscriptions)
    .set({ updatedAt: now })
    .where(and(eq(subscriptions.targetInstanceId, instanceId), isNull(subscriptions.revokedAt)));
}

/** Authenticated exact-instance event handoff and bounded hosted content maintenance. */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, lte, or, sql, inArray } from 'drizzle-orm';
import { ConnectorEventPayloadProtector } from '@dorkos/connector-providers';
import { MANAGED_CONNECTOR_EVENTS_PERMISSIONS } from '@dorkos/shared/connector-managed-schemas';
import {
  CONNECTOR_EVENT_BATCH_LIMIT,
  type ManagedConnectorEventDelivery,
} from '@dorkos/shared/connector-event-schemas';
import { schema } from '@/db/client';
import {
  ManagedAuthorityUnauthorizedError,
  type ManagedConnectorDatabase,
  type ManagedConnectorPrincipal,
} from './authority-service';

type Transaction = Parameters<Parameters<ManagedConnectorDatabase['transaction']>[0]>[0];

/** Recheck key, link and owner in the same transaction that leases or acknowledges content. */
async function lockEventPrincipal(
  tx: Transaction,
  principal: ManagedConnectorPrincipal,
  now: Date
) {
  const [live] = await tx
    .select({ id: schema.instance.id })
    .from(schema.instance)
    .innerJoin(
      schema.apikey,
      and(
        eq(schema.apikey.id, principal.keyId),
        eq(schema.apikey.referenceId, principal.ownerId),
        eq(schema.apikey.enabled, true),
        or(isNull(schema.apikey.expiresAt), gt(schema.apikey.expiresAt, now)),
        sql`${schema.apikey.metadata}::jsonb @> ${JSON.stringify({ instanceId: principal.instanceId, scope: 'instance' })}::jsonb`,
        sql`${schema.apikey.permissions}::jsonb @> ${JSON.stringify(MANAGED_CONNECTOR_EVENTS_PERMISSIONS)}::jsonb`
      )
    )
    .where(
      and(
        eq(schema.instance.id, principal.instanceId),
        eq(schema.instance.userId, principal.ownerId),
        isNull(schema.instance.revokedAt)
      )
    )
    .for('update');
  const [tenant] = await tx
    .select({ id: schema.connectorTenant.id })
    .from(schema.connectorTenant)
    .where(
      and(
        eq(schema.connectorTenant.id, principal.tenantId),
        eq(schema.connectorTenant.ownerUserId, principal.ownerId)
      )
    );
  if (!live || !tenant) throw new ManagedAuthorityUnauthorizedError();
}

/** Lease buffered events without requiring a working vendor SDK configuration. */
export async function pullManagedConnectorEvents(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  protector: ConnectorEventPayloadProtector,
  limit: number,
  now = new Date()
): Promise<{ events: ManagedConnectorEventDelivery[] }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > CONNECTOR_EVENT_BATCH_LIMIT)
    throw new Error('Invalid event batch limit.');
  const inbox = schema.managedConnectorEventInbox;
  const subscription = schema.managedConnectorEventSubscription;
  const binding = schema.managedConnectorEventBinding;
  const definition = schema.managedConnectorEventDefinition;
  const connection = schema.managedConnectorConnection;
  const provider = schema.managedConnectorProvider;
  return db.transaction(async (tx) => {
    await lockEventPrincipal(tx, principal, now);
    const rows = await tx
      .select({ inbox, providerInstanceId: binding.providerInstanceId })
      .from(inbox)
      .innerJoin(
        subscription,
        and(eq(subscription.tenantId, inbox.tenantId), eq(subscription.id, inbox.subscriptionId))
      )
      .innerJoin(
        binding,
        and(eq(binding.tenantId, subscription.tenantId), eq(binding.id, subscription.bindingId))
      )
      .innerJoin(
        definition,
        and(eq(definition.tenantId, binding.tenantId), eq(definition.id, binding.definitionId))
      )
      .innerJoin(
        connection,
        and(
          eq(connection.tenantId, subscription.tenantId),
          eq(connection.id, subscription.connectionId)
        )
      )
      .innerJoin(
        provider,
        and(eq(provider.tenantId, binding.tenantId), eq(provider.id, binding.providerInstanceId))
      )
      .where(
        and(
          eq(inbox.tenantId, principal.tenantId),
          eq(inbox.targetInstanceId, principal.instanceId),
          eq(subscription.targetInstanceId, principal.instanceId),
          eq(connection.originatingInstanceId, principal.instanceId),
          eq(subscription.enabled, true),
          isNull(subscription.revokedAt),
          eq(subscription.scopeVersion, inbox.subscriptionVersion),
          eq(subscription.connectionGeneration, connection.bindingGeneration),
          eq(binding.state, 'ready'),
          eq(definition.current, true),
          eq(connection.lifecycle, 'active'),
          eq(connection.authenticationStatus, 'active'),
          eq(provider.enabled, true),
          eq(binding.providerGeneration, provider.materialGeneration),
          eq(connection.materialGeneration, provider.materialGeneration),
          eq(binding.externalAccountRef, connection.externalAccountRef),
          eq(binding.providerInstanceId, connection.providerInstanceId),
          gt(inbox.expiresAt, now),
          or(
            eq(inbox.state, 'received'),
            and(eq(inbox.state, 'leased'), lte(inbox.leasedUntil, now))
          )
        )
      )
      .orderBy(inbox.receivedAt, inbox.id)
      .limit(limit)
      .for('update', { skipLocked: true });
    const events: ManagedConnectorEventDelivery[] = [];
    for (const { inbox: row, providerInstanceId } of rows) {
      const expiresAt = row.expiresAt.toISOString();
      const content = protector.reveal(
        row.protectedPayload,
        {
          tenantId: row.tenantId,
          providerInstanceId,
          subscriptionId: row.subscriptionId,
          providerEventId: row.providerEventId,
          expiresAt,
        },
        now.getTime()
      );
      const leaseToken = randomUUID();
      await tx
        .update(inbox)
        .set({
          state: 'leased',
          leaseToken,
          leaseKeyId: principal.keyId,
          leasedUntil: new Date(Math.min(now.getTime() + 60_000, row.expiresAt.getTime())),
        })
        .where(and(eq(inbox.tenantId, principal.tenantId), eq(inbox.id, row.id)));
      events.push({
        id: row.id,
        subscriptionId: row.subscriptionId,
        subscriptionVersion: row.subscriptionVersion,
        providerEventId: row.providerEventId,
        leaseToken,
        receivedAt: row.receivedAt.toISOString(),
        expiresAt,
        content,
      });
    }
    return { events };
  });
}

/** ACK means durable local acceptance; clear hosted content without claiming destination completion. */
export async function acknowledgeManagedConnectorEvents(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  events: Array<{ id: string; leaseToken: string }>,
  now = new Date()
): Promise<{ acknowledged: number }> {
  if (events.length < 1 || events.length > CONNECTOR_EVENT_BATCH_LIMIT)
    throw new Error('Invalid event batch limit.');
  const inbox = schema.managedConnectorEventInbox;
  return db.transaction(async (tx) => {
    await lockEventPrincipal(tx, principal, now);
    let acknowledged = 0;
    for (const event of events) {
      const [row] = await tx
        .update(inbox)
        .set({
          state: 'acknowledged',
          protectedPayload: '',
          acknowledgedAt: now,
          leasedUntil: null,
        })
        .where(
          and(
            eq(inbox.tenantId, principal.tenantId),
            eq(inbox.id, event.id),
            eq(inbox.targetInstanceId, principal.instanceId),
            eq(inbox.leaseKeyId, principal.keyId),
            eq(inbox.leaseToken, event.leaseToken),
            eq(inbox.state, 'leased'),
            gt(inbox.leasedUntil, now)
          )
        )
        .returning({ id: inbox.id });
      if (row) acknowledged++;
      else {
        const [prior] = await tx
          .select({ id: inbox.id })
          .from(inbox)
          .where(
            and(
              eq(inbox.tenantId, principal.tenantId),
              eq(inbox.id, event.id),
              eq(inbox.targetInstanceId, principal.instanceId),
              eq(inbox.leaseKeyId, principal.keyId),
              eq(inbox.leaseToken, event.leaseToken),
              eq(inbox.state, 'acknowledged')
            )
          );
        if (prior) acknowledged++;
      }
    }
    return { acknowledged };
  });
}

/** Bounded all-state cleanup for existing cron and opportunistic ingress/pull maintenance. */
export async function sweepManagedConnectorEventRetention(
  db: ManagedConnectorDatabase,
  now = new Date()
) {
  const inbox = schema.managedConnectorEventInbox;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ tenantId: inbox.tenantId, id: inbox.id, state: inbox.state })
      .from(inbox)
      .where(
        and(
          lte(inbox.expiresAt, now),
          or(sql`${inbox.protectedPayload} <> ''`, inArray(inbox.state, ['received', 'leased']))
        )
      )
      .orderBy(inbox.expiresAt)
      .limit(CONNECTOR_EVENT_BATCH_LIMIT)
      .for('update', { skipLocked: true });
    for (const row of rows)
      await tx
        .update(inbox)
        .set({
          protectedPayload: '',
          state: row.state === 'acknowledged' ? 'acknowledged' : 'expired',
          leasedUntil: null,
        })
        .where(and(eq(inbox.tenantId, row.tenantId), eq(inbox.id, row.id)));
    const old = await tx
      .select({ tenantId: inbox.tenantId, id: inbox.id })
      .from(inbox)
      .where(lte(inbox.metadataExpiresAt, now))
      .orderBy(inbox.metadataExpiresAt)
      .limit(CONNECTOR_EVENT_BATCH_LIMIT)
      .for('update', { skipLocked: true });
    for (const row of old)
      await tx.delete(inbox).where(and(eq(inbox.tenantId, row.tenantId), eq(inbox.id, row.id)));
    return { contentRowsCleared: rows.length, metadataRowsDeleted: old.length };
  });
}

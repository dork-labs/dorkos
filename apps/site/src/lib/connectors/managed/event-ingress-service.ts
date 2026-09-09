/** Signed project envelopes resolve to exact tenant-owned private trigger bindings before persistence. */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ConnectorEventPayloadProtector,
  normalizeConnectorEventContent,
} from '@dorkos/connector-providers';
import type { ConnectorVerifiedEvent } from '@dorkos/shared/connector-events';
import {
  ConnectorEventDefinitionSchema,
  CONNECTOR_EVENT_DELIVERY_WINDOW_MS,
  CONNECTOR_EVENT_METADATA_WINDOW_MS,
} from '@dorkos/shared/connector-event-schemas';
import { schema } from '@/db/client';
import type { ManagedConnectorDatabase } from './authority-service';
import {
  lockManagedEventCapacity,
  MANAGED_EVENT_CAPACITY_POLICY,
  type ManagedEventCapacityPolicy,
} from './event-capacity-service';

type Transaction = Parameters<Parameters<ManagedConnectorDatabase['transaction']>[0]>[0];

/** Private admission result; routes expose one generic overload contract. */
export type ManagedEventIngressOutcome =
  | { status: 'accepted'; tenantId: string; inserted: number }
  | { status: 'rejected' }
  | {
      status: 'limited';
      reason: 'rate' | 'subscriptions' | 'rows' | 'bytes';
      retryAfterSeconds: number;
    };

/** Internal deterministic seams for quota boundary tests. */
export interface ManagedEventIngressOptions {
  policy?: ManagedEventCapacityPolicy;
  databaseClock?: (tx: Transaction) => Promise<Date>;
}

async function readDatabaseClock(tx: Transaction): Promise<Date> {
  const result = await tx.execute(sql`select clock_timestamp() as now`);
  return new Date((result.rows[0] as { now: string | Date }).now);
}

function nextMinuteRetrySeconds(now: Date): number {
  return Math.max(1, 60 - now.getUTCSeconds());
}

/** Accept only existing exact owned bindings; a signature never creates tenant or subscription authority. */
export async function acceptManagedConnectorEvent(
  db: ManagedConnectorDatabase,
  event: ConnectorVerifiedEvent,
  protector: ConnectorEventPayloadProtector,
  input: ManagedEventIngressOptions | Date = {}
): Promise<ManagedEventIngressOutcome> {
  const options: ManagedEventIngressOptions =
    input instanceof Date ? { databaseClock: async () => input } : input;
  const policy = options.policy ?? MANAGED_EVENT_CAPACITY_POLICY;
  const b = schema.managedConnectorEventBinding;
  const d = schema.managedConnectorEventDefinition;
  const p = schema.managedConnectorProvider;
  const s = schema.managedConnectorEventSubscription;
  const c = schema.managedConnectorConnection;
  const inbox = schema.managedConnectorEventInbox;
  const candidateRows = await db
    .select({
      tenantId: b.tenantId,
      bindingId: b.id,
      providerUserId: schema.connectorTenant.providerUserId,
    })
    .from(b)
    .innerJoin(d, and(eq(d.tenantId, b.tenantId), eq(d.id, b.definitionId), eq(d.current, true)))
    .innerJoin(
      p,
      and(
        eq(p.tenantId, b.tenantId),
        eq(p.id, b.providerInstanceId),
        eq(p.enabled, true),
        eq(p.materialGeneration, b.providerGeneration)
      )
    )
    .innerJoin(schema.connectorTenant, eq(schema.connectorTenant.id, b.tenantId))
    .where(
      and(
        eq(b.providerInstanceId, 'managed:composio'),
        eq(b.providerTriggerRef, event.providerTriggerRef),
        eq(b.externalAccountRef, event.externalAccountRef),
        eq(b.state, 'ready'),
        eq(d.eventType, event.eventType)
      )
    )
    .limit(2);
  if (candidateRows.length !== 1) return { status: 'rejected' };
  const candidate = candidateRows[0];
  if (event.envelopeVersion === 'V2' && event.providerUserRef !== candidate.providerUserId)
    return { status: 'rejected' };

  return db.transaction(async (tx) => {
    const capacity = await lockManagedEventCapacity(tx, candidate.tenantId, policy);
    const rows = await tx
      .select({ binding: b, definition: d, providerUserId: schema.connectorTenant.providerUserId })
      .from(b)
      .innerJoin(d, and(eq(d.tenantId, b.tenantId), eq(d.id, b.definitionId), eq(d.current, true)))
      .innerJoin(
        p,
        and(
          eq(p.tenantId, b.tenantId),
          eq(p.id, b.providerInstanceId),
          eq(p.enabled, true),
          eq(p.materialGeneration, b.providerGeneration)
        )
      )
      .innerJoin(schema.connectorTenant, eq(schema.connectorTenant.id, b.tenantId))
      .where(
        and(
          eq(b.tenantId, candidate.tenantId),
          eq(b.id, candidate.bindingId),
          eq(b.providerInstanceId, 'managed:composio'),
          eq(b.providerTriggerRef, event.providerTriggerRef),
          eq(b.externalAccountRef, event.externalAccountRef),
          eq(b.state, 'ready'),
          eq(d.eventType, event.eventType)
        )
      )
      .for('update');
    if (rows.length !== 1) return { status: 'rejected' } as const;
    const { binding, definition, providerUserId } = rows[0];
    if (
      event.envelopeVersion === 'V2' &&
      (event.providerUserRef !== providerUserId ||
        event.providerTriggerUuid !== binding.providerTriggerUuid ||
        event.externalAccountUuid !== binding.externalAccountUuid)
    )
      return { status: 'rejected' } as const;
    const subscribers = await tx
      .select({ subscription: s })
      .from(s)
      .innerJoin(c, and(eq(c.tenantId, s.tenantId), eq(c.id, s.connectionId)))
      .where(
        and(
          eq(s.tenantId, binding.tenantId),
          eq(s.bindingId, binding.id),
          eq(s.enabled, true),
          isNull(s.revokedAt),
          eq(c.lifecycle, 'active'),
          eq(c.authenticationStatus, 'active'),
          eq(c.externalAccountRef, binding.externalAccountRef),
          eq(c.providerInstanceId, binding.providerInstanceId),
          eq(c.materialGeneration, binding.providerGeneration),
          eq(c.providerUserId, providerUserId),
          eq(c.bindingGeneration, s.connectionGeneration),
          eq(c.originatingInstanceId, s.targetInstanceId)
        )
      )
      .limit(policy.bindingSubscriptionLimit + 1)
      .for('update');
    if (subscribers.length === 0) return { status: 'rejected' } as const;
    if (subscribers.length > policy.bindingSubscriptionLimit)
      return {
        status: 'limited',
        reason: 'subscriptions',
        retryAfterSeconds: policy.overloadRetrySeconds,
      } as const;
    const subscriptionIds = subscribers.map(({ subscription }) => subscription.id);
    const existing = await tx
      .select({ subscriptionId: inbox.subscriptionId })
      .from(inbox)
      .where(
        and(
          eq(inbox.tenantId, binding.tenantId),
          eq(inbox.providerEventId, event.authenticatedWebhookId),
          inArray(inbox.subscriptionId, subscriptionIds)
        )
      )
      .for('update');
    const existingIds = new Set(existing.map((row) => row.subscriptionId));
    const missing = subscribers.filter(({ subscription }) => !existingIds.has(subscription.id));
    if (missing.length === 0)
      return { status: 'accepted', tenantId: binding.tenantId, inserted: 0 } as const;

    const clock = await (options.databaseClock ?? readDatabaseClock)(tx);
    const sampledMinute = new Date(
      Date.UTC(
        clock.getUTCFullYear(),
        clock.getUTCMonth(),
        clock.getUTCDate(),
        clock.getUTCHours(),
        clock.getUTCMinutes()
      )
    );
    const advanceWindow = sampledMinute > capacity.rateWindowStartedAt;
    const effectiveWindow = advanceWindow ? sampledMinute : capacity.rateWindowStartedAt;
    const effectiveCount = advanceWindow ? 0 : capacity.acceptedInWindow;
    const retryAfterSeconds = nextMinuteRetrySeconds(clock);
    if (effectiveCount + 1 > policy.rateLimit)
      return { status: 'limited', reason: 'rate', retryAfterSeconds } as const;
    if (capacity.retainedRows + missing.length > policy.retainedRowLimit)
      return {
        status: 'limited',
        reason: 'rows',
        retryAfterSeconds: policy.overloadRetrySeconds,
      } as const;
    if (capacity.protectedPayloadBytes >= policy.protectedByteLimit)
      return {
        status: 'limited',
        reason: 'bytes',
        retryAfterSeconds: policy.overloadRetrySeconds,
      } as const;

    const content = normalizeConnectorEventContent(
      ConnectorEventDefinitionSchema.parse(definition.definition),
      event.payload
    );
    const expiresAt = new Date(clock.getTime() + CONNECTOR_EVENT_DELIVERY_WINDOW_MS);
    const metadataExpiresAt = new Date(clock.getTime() + CONNECTOR_EVENT_METADATA_WINDOW_MS);
    const values = missing.map(({ subscription }) => {
      const protectedPayload = protector.protect(content, {
        tenantId: binding.tenantId,
        providerInstanceId: binding.providerInstanceId,
        subscriptionId: subscription.id,
        providerEventId: event.authenticatedWebhookId,
        expiresAt: expiresAt.toISOString(),
      });
      return {
        tenantId: binding.tenantId,
        subscriptionId: subscription.id,
        subscriptionVersion: subscription.scopeVersion,
        providerEventId: event.authenticatedWebhookId,
        targetInstanceId: subscription.targetInstanceId,
        protectedPayload,
        receivedAt: clock,
        expiresAt,
        metadataExpiresAt,
      };
    });
    const addedBytes = values.reduce(
      (total, value) => total + Buffer.byteLength(value.protectedPayload),
      0
    );
    if (capacity.protectedPayloadBytes + addedBytes > policy.protectedByteLimit)
      return {
        status: 'limited',
        reason: 'bytes',
        retryAfterSeconds: policy.overloadRetrySeconds,
      } as const;
    const inserted = await tx
      .insert(inbox)
      .values(values)
      .onConflictDoNothing({
        target: [inbox.tenantId, inbox.subscriptionId, inbox.providerEventId],
      })
      .returning({ id: inbox.id });
    if (inserted.length !== missing.length)
      throw new Error('Managed event capacity changed during admission.');
    await tx
      .update(schema.managedConnectorEventCapacity)
      .set({
        rateWindowStartedAt: effectiveWindow,
        acceptedInWindow: effectiveCount + 1,
        retainedRows: capacity.retainedRows + inserted.length,
        protectedPayloadBytes: capacity.protectedPayloadBytes + addedBytes,
        nextCleanupAt:
          capacity.nextCleanupAt && capacity.nextCleanupAt <= expiresAt
            ? capacity.nextCleanupAt
            : expiresAt,
        updatedAt: clock,
      })
      .where(eq(schema.managedConnectorEventCapacity.tenantId, binding.tenantId));
    return { status: 'accepted', tenantId: binding.tenantId, inserted: inserted.length } as const;
  });
}

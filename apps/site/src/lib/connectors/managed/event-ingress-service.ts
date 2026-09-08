/** Signed project envelopes resolve to exact tenant-owned private trigger bindings before persistence. */
import { and, eq, isNull } from 'drizzle-orm';
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

/** Accept only existing exact owned bindings; a signature never creates tenant or subscription authority. */
export async function acceptManagedConnectorEvent(
  db: ManagedConnectorDatabase,
  event: ConnectorVerifiedEvent,
  protector: ConnectorEventPayloadProtector,
  now = new Date()
): Promise<'accepted' | 'rejected'> {
  const b = schema.managedConnectorEventBinding;
  const d = schema.managedConnectorEventDefinition;
  const p = schema.managedConnectorProvider;
  const s = schema.managedConnectorEventSubscription;
  const c = schema.managedConnectorConnection;
  return db.transaction(async (tx) => {
    const candidates = await tx
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
          eq(b.providerInstanceId, 'managed:composio'),
          eq(b.providerTriggerRef, event.providerTriggerRef),
          eq(b.externalAccountRef, event.externalAccountRef),
          eq(b.state, 'ready'),
          eq(d.eventType, event.eventType)
        )
      )
      .for('update');
    if (candidates.length !== 1) return 'rejected';
    const { binding, definition, providerUserId } = candidates[0];
    if (
      event.envelopeVersion === 'V2' &&
      (event.providerUserRef !== providerUserId ||
        event.providerTriggerUuid !== binding.providerTriggerUuid ||
        event.externalAccountUuid !== binding.externalAccountUuid)
    )
      return 'rejected';
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
      .for('update');
    if (subscribers.length === 0) return 'rejected';
    const content = normalizeConnectorEventContent(
      ConnectorEventDefinitionSchema.parse(definition.definition),
      event.payload
    );
    const expiresAt = new Date(now.getTime() + CONNECTOR_EVENT_DELIVERY_WINDOW_MS);
    for (const { subscription } of subscribers) {
      const scope = {
        tenantId: binding.tenantId,
        providerInstanceId: binding.providerInstanceId,
        subscriptionId: subscription.id,
        providerEventId: event.authenticatedWebhookId,
        expiresAt: expiresAt.toISOString(),
      };
      await tx
        .insert(schema.managedConnectorEventInbox)
        .values({
          tenantId: binding.tenantId,
          subscriptionId: subscription.id,
          subscriptionVersion: subscription.scopeVersion,
          providerEventId: event.authenticatedWebhookId,
          targetInstanceId: subscription.targetInstanceId,
          protectedPayload: protector.protect(content, scope),
          receivedAt: now,
          expiresAt,
          metadataExpiresAt: new Date(now.getTime() + CONNECTOR_EVENT_METADATA_WINDOW_MS),
        })
        .onConflictDoNothing({
          target: [
            schema.managedConnectorEventInbox.tenantId,
            schema.managedConnectorEventInbox.subscriptionId,
            schema.managedConnectorEventInbox.providerEventId,
          ],
        });
    }
    return 'accepted';
  });
}

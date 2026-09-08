/** Verified private binding resolution and protected local inbox acceptance. */
import type { ConnectorVerifiedEvent } from '@dorkos/shared/connector-events';
import {
  CONNECTOR_EVENT_DELIVERY_WINDOW_MS,
  type ConnectorEventContent,
} from '@dorkos/shared/connector-event-schemas';
import {
  ConnectorEventPayloadProtector,
  normalizeConnectorEventContent,
} from '@dorkos/connector-providers';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';
import type { ConnectorEventInboxStore } from '../event-inbox-store.js';
import type { ConnectorSubscriptionStore } from './subscription-store.js';

/** Resolve independently stored protection keys without depending on a cloud link. */
export interface ConnectorEventProtectionPort {
  resolve(providerInstanceId: string): Promise<ConnectorEventPayloadProtector | undefined>;
}

/** Same durable local ingress used by signed BYO events and managed handoff. */
export class ConnectorEventIngressService {
  constructor(
    private readonly subscriptions: ConnectorSubscriptionStore,
    private readonly inbox: ConnectorEventInboxStore,
    private readonly protection: ConnectorEventProtectionPort,
    private readonly now = () => new Date().toISOString()
  ) {}

  /** Accept signed BYO events only under exact registered trigger/account/user mappings. */
  async accept(
    providerInstanceId: string,
    event: ConnectorVerifiedEvent
  ): Promise<'accepted' | 'rejected' | 'unavailable'> {
    const protector = await this.protection.resolve(providerInstanceId);
    if (!protector) return 'unavailable';
    const receivedAt = this.now();
    const expiresAt = new Date(
      Date.parse(receivedAt) + CONNECTOR_EVENT_DELIVERY_WINDOW_MS
    ).toISOString();
    return this.subscriptions.db.transaction(() => {
      const bindings = this.subscriptions.db.$client
        .prepare(
          `SELECT b.id, b.provider_trigger_ref, b.provider_trigger_uuid, b.external_account_ref, b.external_account_uuid
         FROM connector_event_bindings b JOIN connector_provider_instances p ON p.id = b.provider_instance_id
         JOIN connector_event_definitions d ON d.id = b.definition_id AND d.current = 1
         WHERE b.provider_instance_id = ? AND b.state = 'ready' AND b.provider_generation = p.execution_config_generation
         AND p.mode = 'byo' AND p.status = 'available' AND b.provider_trigger_ref = ? AND b.external_account_ref = ?`
        )
        .all(providerInstanceId, event.providerTriggerRef, event.externalAccountRef) as Array<{
        id: string;
        provider_trigger_ref: string;
        provider_trigger_uuid: string | null;
        external_account_ref: string;
        external_account_uuid: string | null;
      }>;
      if (bindings.length !== 1) return 'rejected';
      const binding = bindings[0];
      if (
        event.envelopeVersion === 'V2' &&
        (event.providerTriggerUuid !== binding.provider_trigger_uuid ||
          event.externalAccountUuid !== binding.external_account_uuid)
      )
        return 'rejected';
      const subscribers = this.subscriptions.db.$client
        .prepare(
          'SELECT id FROM connector_event_subscriptions WHERE binding_id = ? AND enabled = 1 AND revoked_at IS NULL'
        )
        .all(binding.id) as Array<{ id: string }>;
      let accepted = 0;
      for (const subscriber of subscribers) {
        const current = this.subscriptions.active(subscriber.id);
        if (!current || current.definition.eventType !== event.eventType) continue;
        // User/project identity is checked at the provider verifier composition;
        // exact private account and trigger pairs bind legacy envelopes here.
        const content = normalizeConnectorEventContent(current.definition, event.payload);
        const scope = {
          providerInstanceId,
          subscriptionId: current.subscriptionId,
          providerEventId: event.authenticatedWebhookId,
          expiresAt,
        };
        this.inbox.enqueue({
          ...scope,
          providerInstanceId: providerInstanceId as ConnectorProviderInstanceId,
          subscriptionVersion: current.subscriptionVersion,
          payloadSchemaVersion: 1,
          normalizedPayload: protector.protect(content, scope),
          payloadProtection: 'encrypted',
          receivedAt,
        });
        accepted++;
      }
      return accepted > 0 ? 'accepted' : 'rejected';
    });
  }

  /** Preserve the hosted original expiry; acknowledge remotely only after this transaction commits. */
  async acceptManaged(
    input: {
      providerInstanceId: ConnectorProviderInstanceId;
      providerGeneration: number;
      subscriptionId: string;
      subscriptionVersion: number;
      providerEventId: string;
      content: ConnectorEventContent;
      receivedAt: string;
      expiresAt: string;
    },
    isCurrent: () => boolean
  ): Promise<{ id: string; inserted: boolean } | undefined> {
    if (!isCurrent()) return undefined;
    // Receipt recovery is independent of current receive consent and encryption
    // keys: it cannot insert content or reactivate a revoked subscription.
    const prior = () =>
      this.subscriptions.db.$client
        .prepare(
          `SELECT i.id FROM connector_event_inbox i
      JOIN connector_event_subscriptions s ON s.id = i.subscription_id
      JOIN connector_event_bindings b ON b.id = s.binding_id
      JOIN connector_provider_instances p ON p.id = i.provider_instance_id
      WHERE i.provider_instance_id = ? AND i.subscription_id = ? AND i.subscription_version = ?
        AND i.provider_event_id = ? AND i.received_at = ? AND i.expires_at = ?
        AND p.mode = 'managed' AND p.execution_config_generation = ? AND b.provider_generation = ?`
        )
        .get(
          input.providerInstanceId,
          input.subscriptionId,
          input.subscriptionVersion,
          input.providerEventId,
          input.receivedAt,
          input.expiresAt,
          input.providerGeneration,
          input.providerGeneration
        ) as { id: string } | undefined;
    const existing = prior();
    if (existing) return { id: existing.id, inserted: false };
    const protector = await this.protection.resolve(input.providerInstanceId);
    if (!protector) return undefined;
    const now = this.now();
    if (
      !Number.isFinite(Date.parse(input.receivedAt)) ||
      Date.parse(input.receivedAt) > Date.parse(now) + 300_000 ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= Date.parse(now) ||
      Date.parse(input.expiresAt) >
        Date.parse(input.receivedAt) + CONNECTOR_EVENT_DELIVERY_WINDOW_MS
    )
      return undefined;
    return this.subscriptions.db.transaction(() => {
      if (!isCurrent()) return undefined;
      const recovered = prior();
      if (recovered) return { id: recovered.id, inserted: false };
      const current = this.subscriptions.active(input.subscriptionId, input.subscriptionVersion);
      if (
        !current ||
        current.mode !== 'managed' ||
        current.providerInstanceId !== input.providerInstanceId ||
        current.providerGeneration !== input.providerGeneration
      )
        return undefined;
      const normalizedPayload = protector.protect(input.content, input);
      return this.inbox.enqueue({
        ...input,
        normalizedPayload,
        payloadProtection: 'encrypted',
        payloadSchemaVersion: 1,
      });
    });
  }
}

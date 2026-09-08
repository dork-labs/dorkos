/** Exact native messaging target for one owner-approved event destination. */
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import type { ConnectorEventContent } from '@dorkos/shared/connector-event-schemas';
import type { PrivateNotificationOptions, PrivateNotificationResult } from '@dorkos/relay';
import { stableStringify } from '@dorkos/shared/capabilities';
import { bindingAllowsInitiate } from '../../relay/initiate-consent.js';
import { buildBridgePrincipal } from '../../relay/bridge-principal.js';
import type { ActiveEventSubscription } from './subscription-store.js';
import type { ConnectorEventChannelDestination } from './delivery-service.js';

/** Existing native connection and private Relay methods supplied only by server composition. */
export interface ConnectorEventNativeDestinationOptions {
  bindings():
    | {
        getById(id: string): AdapterBinding | undefined;
        resolve(
          adapterId: string,
          chatId?: string,
          channelType?: string
        ): AdapterBinding | undefined;
      }
    | undefined;
  adapters(): Array<{ config: { id: string; type: string; enabled: boolean } }>;
  agentSubject(agentId: string): string | undefined;
  relay: {
    deliverPrivateNotification(
      subject: string,
      text: string,
      options: PrivateNotificationOptions
    ): Promise<PrivateNotificationResult>;
  };
}

/** No recent-chat fallback: only the selected exact native connection can receive this event. */
export class ConnectorEventNativeDestination implements ConnectorEventChannelDestination {
  constructor(private readonly options: ConnectorEventNativeDestinationOptions) {}

  /** Send at most 4,000 characters once, with a visible shortening notice and exact native receipt. */
  async deliver(
    scope: ActiveEventSubscription,
    content: ConnectorEventContent,
    authorizeDispatch: () => boolean
  ): Promise<PrivateNotificationResult> {
    const target = this.resolve(scope);
    if (!target) return { state: 'refused' };
    const full = `${content.title}\n\n${content.text}`;
    const suffix = '\n\n[Notification shortened]';
    const text = full.length > 4_000 ? full.slice(0, 4_000 - suffix.length) + suffix : full;
    return this.options.relay.deliverPrivateNotification(target.subject, text, {
      adapterId: target.adapterId,
      from: target.from,
      ...(target.bridged ? { serverBridgePrincipal: true } : {}),
      budget: { maxHops: 1, callBudgetRemaining: 1, ttl: Date.now() + 30_000 },
      authorizeDispatch: () =>
        stableStringify(this.resolve(scope)) === stableStringify(target) && authorizeDispatch(),
    });
  }

  private resolve(scope: ActiveEventSubscription) {
    if (scope.destinationKind !== 'channel') return undefined;
    const store = this.options.bindings();
    const binding = store?.getById(scope.destinationId);
    if (
      !binding ||
      binding.agentId !== scope.agentId ||
      !binding.chatId ||
      !bindingAllowsInitiate(binding)
    )
      return undefined;
    // A newer, more specific binding must not silently redirect the same subject.
    if (store?.resolve(binding.adapterId, binding.chatId, binding.channelType)?.id !== binding.id)
      return undefined;
    const adapter = this.options
      .adapters()
      .find((item) => item.config.id === binding.adapterId && item.config.enabled);
    if (!adapter || !['slack', 'telegram'].includes(adapter.config.type)) return undefined;
    const bridged = binding.bridge === 'room';
    const from = bridged
      ? buildBridgePrincipal('initiate', binding.adapterId, binding.chatId)
      : this.options.agentSubject(scope.agentId);
    if (!from) return undefined;
    return {
      bindingId: binding.id,
      agentId: binding.agentId,
      adapterId: binding.adapterId,
      subject: `relay.human.${adapter.config.type}.${binding.adapterId}.${binding.channelType === 'group' ? 'group.' : ''}${binding.chatId}`,
      from,
      bridged,
    };
  }
}

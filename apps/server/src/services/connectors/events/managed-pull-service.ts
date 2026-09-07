/** Existing linked-instance delivery handoff; local durability precedes every hosted ACK. */
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';
import {
  ManagedConnectorEventPullResponseSchema,
  type ManagedConnectorEventPullResponse,
} from '@dorkos/shared/connector-event-schemas';
import type { ConnectorEventIngressService } from './ingress-service.js';

/** Authenticated cloud port; account and tenant identity remain owned by CloudLinkManager. */
export interface ManagedEventDeliveryCloudPort {
  pullManagedConnectorEvents(
    limit: number,
    signal: AbortSignal
  ): Promise<ManagedConnectorEventPullResponse>;
  acknowledgeManagedConnectorEvents(
    events: Array<{ id: string; leaseToken: string }>,
    signal: AbortSignal
  ): Promise<{ acknowledged: number }>;
}
/** Exact private link/provider material observed before accepting a network handoff. */
export interface ManagedEventLocalBinding {
  providerInstanceId: ConnectorProviderInstanceId;
  providerGeneration: number;
  linkGeneration: string;
}

/** Bounded pull step used by existing application maintenance, with no second queue. */
export class ManagedConnectorEventPullService {
  private running = false;
  constructor(
    private readonly cloud: ManagedEventDeliveryCloudPort,
    private readonly ingress: ConnectorEventIngressService,
    private readonly current: () => ManagedEventLocalBinding | undefined
  ) {}

  /** Commit normalized protected rows first; uncertain ACKs are safe to retry by inbox identity. */
  async recover(signal: AbortSignal): Promise<{ accepted: number; acknowledged: number }> {
    if (this.running) return { accepted: 0, acknowledged: 0 };
    const binding = this.current();
    if (!binding) return { accepted: 0, acknowledged: 0 };
    this.running = true;
    try {
      const page = ManagedConnectorEventPullResponseSchema.parse(
        await this.cloud.pullManagedConnectorEvents(50, signal)
      );
      const receipts: Array<{ id: string; leaseToken: string }> = [];
      for (const delivery of page.events) {
        const live = this.current();
        if (
          signal.aborted ||
          !live ||
          live.providerInstanceId !== binding.providerInstanceId ||
          live.providerGeneration !== binding.providerGeneration ||
          live.linkGeneration !== binding.linkGeneration
        )
          break;
        const accepted = await this.ingress.acceptManaged(
          {
            ...binding,
            subscriptionId: delivery.subscriptionId,
            subscriptionVersion: delivery.subscriptionVersion,
            providerEventId: delivery.providerEventId,
            content: delivery.content,
            receivedAt: delivery.receivedAt,
            expiresAt: delivery.expiresAt,
          },
          () => {
            const latest = this.current();
            return (
              !signal.aborted &&
              Boolean(
                latest &&
                latest.providerInstanceId === binding.providerInstanceId &&
                latest.providerGeneration === binding.providerGeneration &&
                latest.linkGeneration === binding.linkGeneration
              )
            );
          }
        );
        if (accepted) receipts.push({ id: delivery.id, leaseToken: delivery.leaseToken });
      }
      if (!receipts.length) return { accepted: 0, acknowledged: 0 };
      const live = this.current();
      if (
        !live ||
        live.linkGeneration !== binding.linkGeneration ||
        live.providerGeneration !== binding.providerGeneration ||
        live.providerInstanceId !== binding.providerInstanceId
      )
        return { accepted: receipts.length, acknowledged: 0 };
      const result = await this.cloud.acknowledgeManagedConnectorEvents(receipts, signal);
      return { accepted: receipts.length, acknowledged: result.acknowledged };
    } finally {
      this.running = false;
    }
  }
}

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

/** The wait after a first failed pull; it doubles with each failure after that. */
export const MANAGED_PULL_RETRY_START_MS = 30_000;
/**
 * The longest wait between failed pulls. Short on purpose: these are the events
 * an agent acts on (a new email, a message), and after the cloud recovers the
 * first one waits for the next try. Five minutes is 12 asks an hour against 120.
 */
export const MANAGED_PULL_RETRY_MAX_MS = 5 * 60_000;

/** Bounded pull step used by existing application maintenance, with no second queue. */
export class ManagedConnectorEventPullService {
  private running = false;
  /**
   * After a failed pull, the earliest time to ask again, and how long the wait
   * after the next failure will be. The maintenance beat asks every 30 s; while
   * the cloud refuses (a 503 for hours, a 404 until relinked) that was a request
   * and a warning every 30 s (DOR-2903). A success, a new link or a reconnected
   * account starts over.
   */
  private retry: {
    notBefore: number;
    nextWaitMs: number;
    linkGeneration: string;
    providerGeneration: number;
  } | null = null;
  constructor(
    private readonly cloud: ManagedEventDeliveryCloudPort,
    private readonly ingress: ConnectorEventIngressService,
    private readonly current: () => ManagedEventLocalBinding | undefined,
    private readonly now: () => number = Date.now
  ) {}

  /** Commit normalized protected rows first; uncertain ACKs are safe to retry by inbox identity. */
  async recover(signal: AbortSignal): Promise<{ accepted: number; acknowledged: number }> {
    if (this.running) return { accepted: 0, acknowledged: 0 };
    const binding = this.current();
    if (!binding) return { accepted: 0, acknowledged: 0 };
    if (
      this.retry?.linkGeneration !== binding.linkGeneration ||
      this.retry.providerGeneration !== binding.providerGeneration
    )
      this.retry = null;
    if (this.retry && this.now() < this.retry.notBefore) return { accepted: 0, acknowledged: 0 };
    this.running = true;
    try {
      const result = await this.pull(binding, signal);
      this.retry = null;
      return result;
    } catch (err) {
      const waitMs = this.retry?.nextWaitMs ?? MANAGED_PULL_RETRY_START_MS;
      this.retry = {
        notBefore: this.now() + waitMs,
        nextWaitMs: Math.min(waitMs * 2, MANAGED_PULL_RETRY_MAX_MS),
        linkGeneration: binding.linkGeneration,
        providerGeneration: binding.providerGeneration,
      };
      throw err;
    } finally {
      this.running = false;
    }
  }

  /** One pull, accept and acknowledge pass against `binding`. */
  private async pull(
    binding: ManagedEventLocalBinding,
    signal: AbortSignal
  ): Promise<{ accepted: number; acknowledged: number }> {
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
  }
}

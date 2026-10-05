/** Shared, best-effort observation bookkeeping; no delivery/refund/notice authority. */
import {
  type DeliveryReceiptStore,
  RelayReceiptUnavailableError,
  type ReceiptSettlement,
} from '../delivery-receipt-store.js';
import type { DeliveryResult, PublishResult, ReceiptContext, RelayLogger } from '../types.js';
import { isDetachedAgentSubject } from './detached-agent-subject.js';

/** One publish's trusted context, without caching authoritative receipt state. */
export class ReceiptObservation {
  readonly enabled: boolean;

  constructor(
    subject: string,
    private readonly context: ReceiptContext | undefined,
    private readonly store: DeliveryReceiptStore | undefined,
    private readonly logger?: Pick<RelayLogger, 'warn'>
  ) {
    this.enabled = !!context && isDetachedAgentSubject(subject);
  }

  assertOutsideTransaction(): void {
    if (this.enabled) this.requiredStore().assertOutsideTransaction();
  }

  prepare(): void {
    if (this.enabled) this.requiredStore().ensureReady();
  }

  create(messageId: string, subject: string): void {
    if (this.enabled) this.requiredStore().create(messageId, subject, this.context!.ownerUserId);
  }

  captureLocator(messageId: string): void {
    if (this.enabled) this.context!.onReceiptCreated(messageId);
  }

  /** Read SQL after dispatch scheduling, including any fast terminal outcome. */
  withReceipt(result: PublishResult): PublishResult {
    if (!this.enabled) return result;
    const receipt = this.requiredStore().get(result.messageId, { loginEnabled: false });
    if (!receipt) throw new RelayReceiptUnavailableError('RELAY_RECEIPT_STORAGE_UNAVAILABLE');
    return { ...result, receipt };
  }

  /** A failed write cannot become a delivery failure; try exactly one unknown fallback. */
  settle(messageId: string, outcome: ReceiptSettlement): void {
    if (!this.enabled) return;
    try {
      this.requiredStore().settle(messageId, outcome);
    } catch {
      this.warn('Delivery receipt observation could not be stored.');
      try {
        this.requiredStore().settle(messageId, { state: 'outcome_unknown' });
      } catch {
        this.warn('Delivery receipt observation remains unavailable.');
      }
    }
  }

  /** Typed machine codes alone describe refusals; adapter error prose is never stored. */
  observeAdapter(messageId: string, result: DeliveryResult | null): void {
    if (result === null) this.settle(messageId, { state: 'failed', code: 'adapter_unavailable' });
    else if (result.skipped) this.settle(messageId, { state: 'failed', code: 'not_dispatched' });
    else if (result.success) this.settle(messageId, { state: 'delivered' });
    else
      this.settle(messageId, {
        state: 'failed',
        code:
          result.code === 'at_capacity' ||
          result.code === 'chat_unavailable' ||
          result.code === 'rate_limited'
            ? result.code
            : 'adapter_failed',
      });
  }

  private requiredStore(): DeliveryReceiptStore {
    if (!this.store) throw new RelayReceiptUnavailableError('RELAY_RECEIPT_STORAGE_UNAVAILABLE');
    return this.store;
  }

  private warn(message: string): void {
    // A diagnostic sink must not interfere with the isolated unknown fallback.
    try {
      this.logger?.warn(message);
    } catch {
      /* Best-effort diagnostic only. */
    }
  }
}

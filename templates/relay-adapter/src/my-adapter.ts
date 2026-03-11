/**
 * Example relay adapter — replace this with your implementation.
 *
 * @module my-adapter
 */
import { BaseRelayAdapter } from '@dorkos/relay';
import type {
  RelayPublisher,
  AdapterContext,
  DeliveryResult,
} from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/**
 * Example relay adapter.
 *
 * Replace this with your adapter implementation. Follow these steps:
 * 1. Rename `MyAdapter` to your adapter name
 * 2. Update `subjectPrefix` to match your channel hierarchy (e.g., 'relay.custom.slack')
 * 3. Implement `_start()` — connect to your external service
 * 4. Implement `_stop()` — disconnect and drain in-flight messages
 * 5. Implement `deliver()` — forward the envelope to your external channel
 */
export class MyAdapter extends BaseRelayAdapter {
  constructor(id: string, config: Record<string, unknown>) {
    const displayName = typeof config.displayName === 'string'
      ? config.displayName
      : 'My Adapter';
    super(id, 'relay.custom.mine', displayName);
  }

  protected async _start(_relay: RelayPublisher): Promise<void> {
    // TODO: Connect to your external service.
    //
    // Store `_relay` on `this.relay` (already done by BaseRelayAdapter)
    // to publish inbound messages later:
    //
    //   await this.relay!.publish('relay.custom.mine.inbound', envelope, {
    //     from: `relay.custom.mine.${this.id}`,
    //   });
  }

  protected async _stop(): Promise<void> {
    // TODO: Disconnect and drain in-flight messages.
  }

  /**
   * Deliver a relay message to the external channel.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param _context - Optional adapter context (agent info, trace IDs, etc.)
   */
  async deliver(
    _subject: string,
    _envelope: RelayEnvelope,
    _context?: AdapterContext,
  ): Promise<DeliveryResult> {
    // TODO: Send the message to your external channel.
    // Call this.trackOutbound() after a successful delivery.
    this.trackOutbound();
    return { success: true };
  }
}

/**
 * Cancelling an agent's held action in a connected app before it runs (spec
 * `trusted-by-default-flip` §5.6), as the client reaches it. A slice of the
 * `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-connector-holds
 */
import type { CancelHeldActionResponse } from './connector-hold-schemas.js';

/** Cancel a held connected-app action. */
export interface ConnectorHoldTransport {
  /**
   * Cancel an action an agent is about to run in a connected app. Rejects when
   * it already ran, was already cancelled, or is no longer waiting.
   */
  cancelHeldConnectorAction(holdId: string): Promise<CancelHeldActionResponse>;
}

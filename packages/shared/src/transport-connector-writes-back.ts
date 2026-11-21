/**
 * The Transport slice for a connected app's writes-back switch (DOR-4794).
 *
 * @module shared/transport-connector-writes-back
 */
import type {
  ConnectorWritesBack,
  ConnectorWritesBackChange,
  ConnectorWritesBackChangeRequest,
} from './connector-exclusion-schemas.js';

/** Whether an agent that only read a connected app may write back to it without asking. */
export interface ConnectorWritesBackTransport {
  /** Read the switch for one connected app. Off until the owner turns it on. */
  getConnectorWritesBack(connectionId: string): Promise<ConnectorWritesBack>;
  /**
   * Turn it on or off. Turning it on needs `confirmsNoOutsideSync: true` and
   * waits for "Confirm it's you" before it resolves; turning it off answers at once.
   */
  setConnectorWritesBack(
    connectionId: string,
    change: ConnectorWritesBackChangeRequest
  ): Promise<ConnectorWritesBackChange>;
}

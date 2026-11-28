/**
 * The Transport methods for a connected app's writes-back switch (DOR-4794),
 * through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/connector-writes-back-methods
 */
import type {
  ConnectorWritesBack,
  ConnectorWritesBackChange,
  ConnectorWritesBackChangeRequest,
} from '@dorkos/shared/connector-exclusion-schemas';
import { createTransportApiClient } from './api-client';

/**
 * The methods.
 *
 * @param baseUrl - The API's base URL.
 */
export function createConnectorWritesBackMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    getConnectorWritesBack(connectionId: string): Promise<ConnectorWritesBack> {
      return api.call('connectors.getConnectionsWritesBack', { path: { connectionId } });
    },

    // Turning it on is held for "Confirm it's you" by the app window's fetch,
    // so this resolves only once the owner confirms (or rejects if they don't).
    setConnectorWritesBack(
      connectionId: string,
      change: ConnectorWritesBackChangeRequest
    ): Promise<ConnectorWritesBackChange> {
      return api.call('connectors.updateConnectionsWritesBack', {
        path: { connectionId },
        body: change,
      });
    },
  };
}

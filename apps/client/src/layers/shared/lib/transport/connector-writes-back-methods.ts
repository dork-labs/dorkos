/**
 * The Transport methods for a connected app's writes-back switch (DOR-4794).
 *
 * @module shared/lib/transport/connector-writes-back-methods
 */
import type {
  ConnectorWritesBack,
  ConnectorWritesBackChange,
  ConnectorWritesBackChangeRequest,
} from '@dorkos/shared/connector-exclusion-schemas';
import { fetchJSON } from './http-client';

/**
 * The methods.
 *
 * @param baseUrl - The API's base URL.
 */
export function createConnectorWritesBackMethods(baseUrl: string) {
  const path = (connectionId: string) =>
    `/connectors/connections/${encodeURIComponent(connectionId)}/writes-back`;
  return {
    getConnectorWritesBack(connectionId: string): Promise<ConnectorWritesBack> {
      return fetchJSON<ConnectorWritesBack>(baseUrl, path(connectionId));
    },

    // Turning it on is held for "Confirm it's you" by the app window's fetch,
    // so this resolves only once the owner confirms (or rejects if they don't).
    setConnectorWritesBack(
      connectionId: string,
      change: ConnectorWritesBackChangeRequest
    ): Promise<ConnectorWritesBackChange> {
      return fetchJSON<ConnectorWritesBackChange>(baseUrl, path(connectionId), {
        method: 'PUT',
        body: JSON.stringify(change),
      });
    },
  };
}

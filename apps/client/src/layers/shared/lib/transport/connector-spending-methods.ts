/**
 * The Transport methods for the monthly spend limit (DOR-4204 PR 2).
 *
 * @module shared/lib/transport/connector-spending-methods
 */
import type { SpendingSummary } from '@dorkos/shared/connector-spending';
import { fetchJSON } from './http-client';

/**
 * The methods.
 *
 * @param baseUrl - The API's base URL.
 */
export function createConnectorSpendingMethods(baseUrl: string) {
  return {
    getConnectorSpending(): Promise<SpendingSummary> {
      return fetchJSON<SpendingSummary>(baseUrl, '/connectors/spending');
    },

    setConnectorSpendingLimit(limitMicro: string | null): Promise<SpendingSummary> {
      return fetchJSON<SpendingSummary>(baseUrl, '/connectors/spending/limit', {
        method: 'PUT',
        body: JSON.stringify({ limit: limitMicro }),
      });
    },

    setConnectorSpendingPrice(
      toolkit: string,
      priceMicro: string | null
    ): Promise<SpendingSummary> {
      return fetchJSON<SpendingSummary>(
        baseUrl,
        `/connectors/spending/prices/${encodeURIComponent(toolkit)}`,
        { method: 'PUT', body: JSON.stringify({ price: priceMicro }) }
      );
    },
  };
}

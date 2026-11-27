/**
 * The Transport methods for the monthly spend limit (DOR-4204 PR 2), through
 * the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/connector-spending-methods
 */
import type { SpendingSummary } from '@dorkos/shared/connector-spending';
import { createTransportApiClient } from './api-client';

/**
 * The methods.
 *
 * @param baseUrl - The API's base URL.
 */
export function createConnectorSpendingMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    getConnectorSpending(): Promise<SpendingSummary> {
      return api.call('connectors.getSpending', {});
    },

    setConnectorSpendingLimit(limitMicro: string | null): Promise<SpendingSummary> {
      return api.call('connectors.updateSpendingLimit', { body: { limit: limitMicro } });
    },

    setConnectorSpendingPrice(
      toolkit: string,
      priceMicro: string | null
    ): Promise<SpendingSummary> {
      return api.call('connectors.updateSpendingPrices', {
        path: { toolkit },
        body: { price: priceMicro },
      });
    },
  };
}

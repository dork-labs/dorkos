/**
 * The Transport slice for the monthly spend limit (DOR-4204 PR 2).
 *
 * @module shared/transport-connector-spending
 */
import type { SpendingSummary } from './connector-spending.js';

/** What the Spending block reads, and a person's changes to the limit and prices. */
export interface ConnectorSpendingTransport {
  /** This month's limit, prices and spending. */
  getConnectorSpending(): Promise<SpendingSummary>;
  /**
   * Set, lower or clear the monthly limit, in micro-units. A first or higher
   * limit waits for "Confirm it's you" before it resolves.
   */
  setConnectorSpendingLimit(limitMicro: string | null): Promise<SpendingSummary>;
  /**
   * Set or clear an app's price per run, in micro-units. A first or lower
   * price waits for "Confirm it's you" before it resolves.
   */
  setConnectorSpendingPrice(toolkit: string, priceMicro: string | null): Promise<SpendingSummary>;
}

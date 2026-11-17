/**
 * The monthly spend limit's Transport mock (DOR-4204 PR 2): no limit set,
 * nothing spent, no prices, and every change answers with that summary.
 *
 * @module test-utils/mock-connector-spending-transport
 */
import { vi } from 'vitest';
import type { SpendingSummary } from '@dorkos/shared/connector-spending';
import type { Transport } from '@dorkos/shared/transport';

/** A month with no limit and nothing spent, resetting Dec 1. */
export function emptySpendingSummary(overrides: Partial<SpendingSummary> = {}): SpendingSummary {
  return {
    currency: 'USD',
    limitMicro: null,
    maxMicro: '10000000000',
    resetsAt: '2026-12-01T00:00:00.000Z',
    prices: {},
    meterReadable: true,
    month: '2026-11',
    usedMicro: '0',
    leftMicro: null,
    overMicro: null,
    approximate: false,
    byApp: [],
    ...overrides,
  };
}

/** Mocks for the spend limit's three methods. */
export function createMockConnectorSpendingTransport(): Pick<
  Transport,
  'getConnectorSpending' | 'setConnectorSpendingLimit' | 'setConnectorSpendingPrice'
> {
  return {
    getConnectorSpending: vi.fn().mockResolvedValue(emptySpendingSummary()),
    setConnectorSpendingLimit: vi
      .fn()
      .mockImplementation(async (limitMicro: string | null) =>
        emptySpendingSummary({ limitMicro, leftMicro: limitMicro, overMicro: limitMicro && '0' })
      ),
    setConnectorSpendingPrice: vi
      .fn()
      .mockImplementation(async (toolkit: string, priceMicro: string | null) =>
        emptySpendingSummary({ prices: priceMicro === null ? {} : { [toolkit]: priceMicro } })
      ),
  };
}

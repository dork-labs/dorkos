/**
 * Mock RelayEnvelope factory for adapter delivery tests.
 *
 * @module relay/testing/mock-relay-envelope
 */
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/**
 * Create a mock RelayEnvelope for adapter delivery tests.
 *
 * Provides sensible defaults that can be overridden via the `overrides` argument.
 *
 * @param overrides - Partial envelope fields to override the defaults
 */
export function createMockRelayEnvelope(
  overrides: Partial<RelayEnvelope> = {},
): RelayEnvelope {
  return {
    id: 'test-envelope-001',
    from: 'relay.test.sender',
    subject: 'relay.test.recipient',
    payload: { type: 'text', body: 'Test message' },
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 30_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

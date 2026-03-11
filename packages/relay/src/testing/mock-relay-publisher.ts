/**
 * Mock RelayPublisher factory for adapter tests.
 *
 * @module relay/testing/mock-relay-publisher
 */
import type { RelayPublisher } from '../types.js';
import { vi } from 'vitest';

/**
 * Create a mock RelayPublisher for adapter tests.
 *
 * All methods are vi.fn() stubs. `publish()` resolves with a default result.
 * `onSignal()` returns a no-op unsubscribe function.
 */
export function createMockRelayPublisher(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'test-msg-001', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
  };
}

/**
 * Shared test fixtures for `@dorkos/relay`.
 *
 * ## Why this module exists
 *
 * {@link createMockRelay} previously existed as four byte-identical private
 * copies (`adapter-registry`, `base-adapter`, `slack/inbound`, `webhook-adapter`).
 * When `RelayPublisher` gained `subscribe()`, all four went stale at once and
 * none of them failed, because no relay test file was in a tsc program until
 * DOR-518. Four copies meant one schema change had to be chased four times; one
 * definition means the compiler reports it once, here.
 *
 * A shared fixture module can never be quarantined out of the check program —
 * `exclude` drops a file from the program's ROOTS, not from the program, so
 * anything an included test imports is pulled back in and typechecked anyway.
 * That makes this file's type-correctness load-bearing, which is the point.
 *
 * The telegram adapter test keeps its own `createMockRelay`: it records signal
 * handlers so the test can fire them, so it is a genuinely different double
 * rather than another copy of this one.
 *
 * @module __tests__/fixtures
 */
import { vi } from 'vitest';
import type { RelayPublisher } from '../types.js';

/**
 * A `RelayPublisher` double whose methods are all inspectable `vi.fn()` spies.
 *
 * `publish` resolves a one-recipient delivery; `onSignal` and `subscribe` return
 * a no-op unsubscribe, matching the real contract that both hand back a function
 * the caller may invoke exactly once.
 *
 * @returns A fresh mock publisher — call per test so spy state never leaks.
 */
export function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

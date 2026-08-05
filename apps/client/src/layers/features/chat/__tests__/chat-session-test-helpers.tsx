/**
 * Shared test infrastructure for `useChatSession` test suites.
 *
 * Provides a deterministic `crypto.randomUUID`. The legacy in-band
 * `sendMessage` SSE helpers were removed with the trigger-only POST contract
 * (spec chat-stream-reconnection, Phase 5 / DOR-74) — tests now drive the
 * per-session stream store directly to simulate `/events`. The `EventSource`
 * mock went with the durable streams becoming WebSockets (ADR 260805-041016):
 * nothing under test constructed one any more, so it was stubbing a global the
 * client never touched.
 *
 * @internal Test-only module.
 */
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock crypto.randomUUID
// ---------------------------------------------------------------------------

export const mockUUID = vi.fn<() => string>();
export let uuidCounter = 0;

export function resetUuidCounter() {
  uuidCounter = 0;
  mockUUID.mockImplementation(() => `uuid-${++uuidCounter}`);
}

mockUUID.mockImplementation(() => `uuid-${++uuidCounter}`);
Object.defineProperty(globalThis.crypto, 'randomUUID', {
  value: mockUUID,
  writable: true,
});

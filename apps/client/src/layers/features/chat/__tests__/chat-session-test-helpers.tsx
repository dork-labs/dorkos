/**
 * Shared test infrastructure for `useChatSession` test suites.
 *
 * Provides a mock EventSource and a deterministic `crypto.randomUUID`. The
 * legacy in-band `sendMessage` SSE helpers were removed with the trigger-only
 * POST contract (spec chat-stream-reconnection, Phase 5 / DOR-74) — tests now
 * drive the per-session stream store directly to simulate `/events`.
 *
 * @internal Test-only module.
 */
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------

export class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Map<string, Array<(event: Event) => void>>;
  readyState: number;

  constructor(url: string) {
    this.url = url;
    this.listeners = new Map();
    this.readyState = 1; // OPEN
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  close() {
    this.readyState = 2; // CLOSED
  }
}

globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

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

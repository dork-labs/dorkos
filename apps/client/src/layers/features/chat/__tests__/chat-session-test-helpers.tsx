/**
 * Shared test infrastructure for `useChatSession` test suites.
 *
 * Provides mock EventSource, wrapper factory, and sendMessage mock builder.
 * Note: `mockAppState` and `vi.mock` for `useAppStore` must live in each
 * test file so the mock factory closure captures the mutable state correctly.
 *
 * @internal Test-only module.
 */
import { vi } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { StreamEvent } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';

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

export const mockUUID = vi.fn();
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

// ---------------------------------------------------------------------------
// Query + Transport wrapper factory
// ---------------------------------------------------------------------------

export function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// sendMessage mock factory
// ---------------------------------------------------------------------------

/** Create a sendMessage mock that fires events via the onEvent callback. */
export function createSendMessageMock(events: StreamEvent[]) {
  return vi.fn(
    async (
      _sessionId: string,
      _content: string,
      onEvent: (event: StreamEvent) => void,
      _signal?: AbortSignal,
      _cwd?: string
    ) => {
      for (const event of events) {
        onEvent(event);
      }
    }
  );
}

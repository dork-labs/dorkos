/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

// The provider no longer owns a connection — it drives the streamManager's
// global list stream (CLI-B5). Mock the manager singleton with a controllable
// fake: state listeners and generic-event subscribers are captured so tests can
// fire transitions/events synchronously.
const { fakeManager, stateListeners, eventListeners, mockInvalidateQueries } = vi.hoisted(() => {
  const stateListeners = new Set<(state: string, attempts: number) => void>();
  const eventListeners = new Map<string, Set<(data: unknown) => void>>();
  const fakeManager = {
    connectList: vi.fn(),
    getListConnectionState: vi.fn().mockReturnValue('connecting'),
    getListFailedAttempts: vi.fn().mockReturnValue(0),
    subscribeListConnectionState: vi.fn((listener: (state: string, attempts: number) => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    }),
    subscribeEvent: vi.fn((name: string, handler: (data: unknown) => void) => {
      let set = eventListeners.get(name);
      if (!set) {
        set = new Set();
        eventListeners.set(name, set);
      }
      set.add(handler);
      return () => eventListeners.get(name)?.delete(handler);
    }),
  };
  return { fakeManager, stateListeners, eventListeners, mockInvalidateQueries: vi.fn() };
});

vi.mock('@/layers/shared/lib/query-client', () => ({
  queryClient: { invalidateQueries: mockInvalidateQueries },
}));

vi.mock('@/layers/shared/lib/transport', () => ({
  streamManager: fakeManager,
}));

import { EventStreamProvider, useEventStream, useEventSubscription } from '../event-stream-context';

function Wrapper({ children }: { children: ReactNode }) {
  return <EventStreamProvider>{children}</EventStreamProvider>;
}

/** Fire a connection-state transition into every captured listener. */
function fireState(state: string, attempts = 0) {
  act(() => {
    for (const listener of [...stateListeners]) listener(state, attempts);
  });
}

/** Fire a generic event into every captured subscriber for `name`. */
function fireEvent(name: string, data: unknown) {
  act(() => {
    for (const handler of [...(eventListeners.get(name) ?? [])]) handler(data);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('EventStreamProvider', () => {
  it('connects the global list stream on mount (idempotent in the manager)', () => {
    renderHook(() => useEventStream(), { wrapper: Wrapper });
    expect(fakeManager.connectList).toHaveBeenCalled();
  });

  it('does not own a connection — unmount only drops the state listener', () => {
    const { unmount } = renderHook(() => useEventStream(), { wrapper: Wrapper });
    const sizeWhileMounted = stateListeners.size;
    unmount();
    expect(stateListeners.size).toBeLessThan(sizeWhileMounted);
  });
});

describe('useEventStream', () => {
  it('throws outside provider', () => {
    expect(() => {
      renderHook(() => useEventStream());
    }).toThrow('useEventStream must be used within an EventStreamProvider');
  });

  it('reflects connection state changes', () => {
    const { result } = renderHook(() => useEventStream(), { wrapper: Wrapper });

    fireState('connected', 0);

    expect(result.current.connectionState).toBe('connected');
    expect(result.current.failedAttempts).toBe(0);
  });

  it('reflects failed attempt counts while reconnecting', () => {
    const { result } = renderHook(() => useEventStream(), { wrapper: Wrapper });

    fireState('reconnecting', 3);

    expect(result.current.connectionState).toBe('reconnecting');
    expect(result.current.failedAttempts).toBe(3);
  });
});

describe('useEventSubscription', () => {
  it('calls handler when matching event fires', () => {
    const handler = vi.fn();
    renderHook(() => useEventSubscription('tunnel_status', handler), {
      wrapper: Wrapper,
    });

    fireEvent('tunnel_status', { connected: true });

    expect(handler).toHaveBeenCalledWith({ connected: true });
  });

  it('does not call handler for non-matching events', () => {
    const handler = vi.fn();
    renderHook(() => useEventSubscription('tunnel_status', handler), {
      wrapper: Wrapper,
    });

    fireEvent('extension_reloaded', { extensionIds: ['a'] });

    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useEventSubscription('tunnel_status', handler), {
      wrapper: Wrapper,
    });

    unmount();

    fireEvent('tunnel_status', { connected: false });

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers to the same event', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    renderHook(
      () => {
        useEventSubscription('tunnel_status', handler1);
        useEventSubscription('tunnel_status', handler2);
      },
      { wrapper: Wrapper }
    );

    fireEvent('tunnel_status', { connected: true });

    expect(handler1).toHaveBeenCalledWith({ connected: true });
    expect(handler2).toHaveBeenCalledWith({ connected: true });
  });
});

describe('refetch-on-reconnect', () => {
  // The invalidation listener is installed once at module scope and tracks the
  // previous state across tests — each test drives an explicit prior state
  // first so assertions are order-independent.

  it('invalidates queries on reconnecting → connected transition', async () => {
    renderHook(() => useEventStream(), { wrapper: Wrapper });

    fireState('reconnecting', 1);
    fireState('connected', 0);

    // Dynamic import is async — flush the microtask queue
    await vi.waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledOnce();
    });
  });

  it('does not invalidate on initial connecting → connected', async () => {
    renderHook(() => useEventStream(), { wrapper: Wrapper });

    fireState('connecting', 0);
    mockInvalidateQueries.mockClear();
    fireState('connected', 0);

    await vi.waitFor(() => {
      expect(mockInvalidateQueries).not.toHaveBeenCalled();
    });
  });

  it('does not invalidate on connected → connected', async () => {
    renderHook(() => useEventStream(), { wrapper: Wrapper });

    fireState('connected', 0);
    mockInvalidateQueries.mockClear();
    fireState('connected', 0);

    await vi.waitFor(() => {
      expect(mockInvalidateQueries).not.toHaveBeenCalled();
    });
  });
});

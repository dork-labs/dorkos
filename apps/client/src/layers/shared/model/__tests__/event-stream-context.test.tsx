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
const { fakeManager, stateListeners, eventListeners, mockInvalidateQueries, setListState } =
  vi.hoisted(() => {
    const stateListeners = new Set<(state: string, attempts: number) => void>();
    const eventListeners = new Map<string, Set<(data: unknown) => void>>();
    // The real manager HOLDS its connection state and answers the getters from it,
    // which is what the provider reads — so this fake holds it too. A double whose
    // getters can disagree with what it just announced would let a test pass
    // against behaviour the running app never has.
    const listState = { state: 'connecting', attempts: 0 };
    const setListState = (state: string, attempts: number) => {
      listState.state = state;
      listState.attempts = attempts;
    };
    const fakeManager = {
      connectList: vi.fn(),
      getListConnectionState: vi.fn(() => listState.state),
      getListFailedAttempts: vi.fn(() => listState.attempts),
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
    return {
      fakeManager,
      stateListeners,
      eventListeners,
      mockInvalidateQueries: vi.fn(),
      setListState,
    };
  });

vi.mock('@/layers/shared/lib/query-client', async (importOriginal) => ({
  // The real `isStreamOwnedQuery`, because the point of the assertion below is
  // that the production predicate excludes the right things — a stub would just
  // be the test agreeing with itself.
  isStreamOwnedQuery: (await importOriginal<typeof import('../../lib/query-client')>())
    .isStreamOwnedQuery,
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
    setListState(state, attempts);
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

  it('spares caches a stream of their own already owns', async () => {
    // A bare `invalidateQueries()` swept a room's history with everything else,
    // and that read answers with the TRAILING page — so recovering from a
    // ten-second blip truncated a room somebody had scrolled back through, and
    // overwrote whatever the socket had already delivered. The room's own
    // stream resumes from a cursor and is gap-free; it does not need help.
    renderHook(() => useEventStream(), { wrapper: Wrapper });

    fireState('reconnecting', 1);
    fireState('connected', 0);

    await vi.waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledOnce());
    const { predicate } = mockInvalidateQueries.mock.calls[0]![0] as {
      predicate: (query: { queryKey: unknown[]; meta?: Record<string, unknown> }) => boolean;
    };

    expect(
      predicate({ queryKey: ['rooms', 'entries', 'room-1'], meta: { streamOwned: true } })
    ).toBe(false);
    // And everything else is still swept, which is the whole point of the
    // handler — a narrowing that spared the world would be no re-sync at all.
    expect(predicate({ queryKey: ['rooms', 'list', null] })).toBe(true);
    expect(predicate({ queryKey: ['sessions'], meta: {} })).toBe(true);
  });

  it('does not invalidate on initial connecting → connected', async () => {
    renderHook(() => useEventStream(), { wrapper: Wrapper });

    fireState('connecting', 0);
    mockInvalidateQueries.mockClear();
    fireState('connected', 0);

    // `vi.waitFor(() => expect(x).not.toHaveBeenCalled())` would pass on its
    // very first poll no matter what the transition above did — it is
    // satisfied by a call that hasn't happened YET, not one that provably
    // never will. The real invalidation (if it fired) lands behind the async
    // `import('@/layers/shared/lib/query-client')` in event-stream-context.tsx,
    // so await that same specifier here: a dynamic import of an
    // already-loaded module resolves its `.then()` queue in call order, and
    // production's `.then()` (attached during the synchronous `fireState`
    // above) was queued before this one — so by the time this import
    // settles, any invalidation it would have scheduled has already run.
    await import('@/layers/shared/lib/query-client');

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it('does not invalidate on connected → connected', async () => {
    renderHook(() => useEventStream(), { wrapper: Wrapper });

    fireState('connected', 0);
    mockInvalidateQueries.mockClear();
    fireState('connected', 0);

    // Same reasoning as above: await the production code's own dynamic
    // import so this check runs after any invalidation it would have
    // scheduled, instead of racing it.
    await import('@/layers/shared/lib/query-client');

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });
});

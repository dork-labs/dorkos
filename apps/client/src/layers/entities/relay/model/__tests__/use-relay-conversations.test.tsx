// @vitest-environment jsdom
/**
 * The relay activity list follows events, not a five-second timer (DOR-2909).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

/** Every handler the hook subscribed, by event name, to fire by hand. */
const handlers = new Map<string, Array<() => void>>();
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
});

import { RELAY_CONVERSATIONS_KEY, useRelayConversations } from '../use-relay-conversations';

afterEach(() => {
  cleanup();
  handlers.clear();
  vi.useRealTimers();
});

function setup(enabled = true) {
  const transport = createMockTransport();
  vi.mocked(transport.listRelayConversations).mockResolvedValue({ conversations: [] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TransportProvider>
  );
  renderHook(() => useRelayConversations(enabled), { wrapper });
  /** Fire the handler the hook subscribed for `event`. */
  const fire = (event: string) => act(() => handlers.get(event)?.at(-1)?.());
  return { transport, queryClient, wrapper, fire };
}

/** Wait past the coalescing window. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

describe('useRelayConversations', () => {
  it('does not ask again while nothing arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { transport } = setup();
    await waitFor(() => expect(transport.listRelayConversations).toHaveBeenCalledTimes(1));
    // Before DOR-2909 this was two more reads in ten quiet seconds.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(transport.listRelayConversations).toHaveBeenCalledTimes(1);
  });

  it.each(['relay_message', 'relay_signal', 'relay_flow', 'relay_dead_letter'])(
    'reads the list again on %s',
    async (event) => {
      const { transport, fire } = setup();
      await waitFor(() => expect(transport.listRelayConversations).toHaveBeenCalledTimes(1));
      fire(event);
      await waitFor(() => expect(transport.listRelayConversations).toHaveBeenCalledTimes(2));
    }
  );

  it('reads the list once for a burst', async () => {
    const { transport, fire } = setup();
    await waitFor(() => expect(transport.listRelayConversations).toHaveBeenCalledTimes(1));
    fire('relay_message');
    fire('relay_message');
    fire('relay_flow');
    await waitFor(() => expect(transport.listRelayConversations).toHaveBeenCalledTimes(2));
    await settle();
    expect(transport.listRelayConversations).toHaveBeenCalledTimes(2);
  });

  it('ignores events while switched off, even when another surface shows the list', async () => {
    const { transport, wrapper, fire } = setup(false);
    // A live reader of the same list elsewhere: an invalidation would refetch it.
    renderHook(
      () =>
        useQuery({
          queryKey: [...RELAY_CONVERSATIONS_KEY],
          queryFn: () => transport.listRelayConversations(),
        }),
      { wrapper }
    );
    await waitFor(() => expect(transport.listRelayConversations).toHaveBeenCalledTimes(1));
    fire('relay_message');
    await settle();
    expect(transport.listRelayConversations).toHaveBeenCalledTimes(1);
  });
});

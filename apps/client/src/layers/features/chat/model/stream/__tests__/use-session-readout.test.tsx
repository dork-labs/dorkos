// @vitest-environment jsdom
/**
 * Reading another session's turns without opening it (DOR-3075): nothing for
 * no session, the newest page mapped to messages, read again while polling,
 * and once more when polling stops so a turn's last steps arrive.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useSessionReadout } from '../use-session-readout';

afterEach(cleanup);

const HISTORY = {
  messages: [{ id: 'u1', role: 'user' as const, content: 'Hi', timestamp: '2026-10-20T13:00:00Z' }],
};

function wrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  };
}

describe('useSessionReadout', () => {
  it('reads nothing without a session', () => {
    const getMessages = vi.fn(async () => HISTORY);
    const { result } = renderHook(() => useSessionReadout(null, false), {
      wrapper: wrapper(createMockTransport({ getMessages } as Partial<Transport>)),
    });
    expect(result.current).toEqual({ messages: [], isLoading: false, isError: false });
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('maps the session’s newest page to messages', async () => {
    const getMessages = vi.fn(async () => HISTORY);
    const { result } = renderHook(() => useSessionReadout('s1', false), {
      wrapper: wrapper(createMockTransport({ getMessages } as Partial<Transport>)),
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]).toMatchObject({ id: 'u1', role: 'user', content: 'Hi' });
    expect(getMessages).toHaveBeenCalledWith('s1');
  });

  it('reads once more when polling stops, so the turn’s last steps load', async () => {
    const getMessages = vi.fn(async () => HISTORY);
    const { rerender } = renderHook(({ polling }) => useSessionReadout('s1', polling), {
      initialProps: { polling: true },
      wrapper: wrapper(createMockTransport({ getMessages } as Partial<Transport>)),
    });
    await waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1));
    const before = getMessages.mock.calls.length;
    rerender({ polling: false });
    await waitFor(() => expect(getMessages.mock.calls.length).toBe(before + 1));
  });

  it('says so when the read fails', async () => {
    const getMessages = vi.fn(async () => {
      throw new Error('403');
    });
    const { result } = renderHook(() => useSessionReadout('s1', false), {
      wrapper: wrapper(createMockTransport({ getMessages } as Partial<Transport>)),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

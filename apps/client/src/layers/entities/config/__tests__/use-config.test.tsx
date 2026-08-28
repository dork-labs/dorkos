// @vitest-environment jsdom
/**
 * The one config read, and the two options that are not decoration.
 *
 * @module entities/config/__tests__/use-config
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useConfig } from '../model/use-config';

let transport: Transport;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  transport = createMockTransport();
});

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe('useConfig', () => {
  it('asks even when the browser says it is offline', async () => {
    // **The server this asks about is not on the internet.** TanStack's default
    // `networkMode: 'online'` PAUSES a fetch while `navigator.onLine` is false —
    // which in the desktop app would stop the cockpit asking whether its own
    // child process is answering, on a machine where it certainly still is. A
    // paused query reports no answer AND no failure, so the shell's unreachable
    // gate would have had nothing to go on either.
    onlineManager.setOnline(false);

    renderHook(() => useConfig(), { wrapper: createWrapper() });

    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
  });

  it('re-asks on a timer only when a caller asks it to', async () => {
    vi.useFakeTimers();
    const interval = 5000;

    renderHook(() => useConfig({ refetchInterval: interval }), { wrapper: createWrapper() });
    await vi.waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(interval);

    await vi.waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(2));
  });

  it('does not poll for the callers that pass nothing', async () => {
    vi.useFakeTimers();

    renderHook(() => useConfig(), { wrapper: createWrapper() });
    await vi.waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(1));

    // A minute of silence: every other reader of this query shares one cache
    // entry, and none of them asked to be woken up.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(transport.getConfig).toHaveBeenCalledTimes(1);
  });
});

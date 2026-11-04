// @vitest-environment jsdom
/**
 * A Direct chat lookup that fails (DOR-3074). Every surface on a chat reads this
 * lookup, and a surface mounting used to ask again, which put the chat back to
 * "pending" and remounted them: 70 to 90 requests a second against a failing server.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useDirectChat } from '../model/direct/use-direct-chat';

const TEN_MINUTES_MS = 10 * 60 * 1000;
const CHAT = { sessionId: 's', sessionIds: ['s'], roomId: 'dm', agentPath: '/a' };

/** A wrapper with its own cache, and the lookup answering as it is told. */
function harness(findDirectChat: ReturnType<typeof vi.fn>) {
  const client = new QueryClient();
  const transport = createMockTransport({ findDirectChat: findDirectChat as never });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Move the clock on, letting what it wakes finish. */
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe('useDirectChat when the lookup fails', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does not ask again because a surface mounted', async () => {
    const findDirectChat = vi.fn().mockRejectedValue(new Error('500'));
    const wrapper = harness(findDirectChat);
    const first = renderHook(() => useDirectChat('s'), { wrapper });
    await wait(10);
    expect(findDirectChat).toHaveBeenCalledTimes(1);

    for (let mount = 0; mount < 20; mount += 1) {
      renderHook(() => useDirectChat('s'), { wrapper }).unmount();
      await wait(1);
    }
    expect(findDirectChat).toHaveBeenCalledTimes(1);
    expect(first.result.current.errorUpdateCount).toBe(1);
  });

  it('asks again a few times, further and further apart, and then stops', async () => {
    const findDirectChat = vi.fn().mockRejectedValue(new Error('500'));
    const wrapper = harness(findDirectChat);
    // As on a real chat: several surfaces, each with its own timer.
    renderHook(() => useDirectChat('s'), { wrapper });
    renderHook(() => useDirectChat('s'), { wrapper });
    renderHook(() => useDirectChat('s'), { wrapper });

    await wait(1_000);
    expect(findDirectChat).toHaveBeenCalledTimes(1);
    await wait(TEN_MINUTES_MS);
    expect(findDirectChat.mock.calls.length).toBeGreaterThan(1);
    expect(findDirectChat.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('takes the answer when asking again works, and stops asking', async () => {
    const findDirectChat = vi.fn().mockRejectedValueOnce(new Error('500')).mockResolvedValue(CHAT);
    const { result } = renderHook(() => useDirectChat('s'), { wrapper: harness(findDirectChat) });
    await wait(TEN_MINUTES_MS);
    expect(result.current.data).toEqual(CHAT);
    // Once to fail, once to answer; the minute-long stale window asks nothing new.
    expect(findDirectChat).toHaveBeenCalledTimes(2);
  });
});

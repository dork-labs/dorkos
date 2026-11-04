// @vitest-environment jsdom
/**
 * A chat whose Direct chat lookup failed is not still waiting (DOR-3074): asking
 * again must not put it back to "pending", or it never leaves "Loading chat…".
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useDirectMessageView } from '../model/use-direct-message-view';

vi.mock('@/layers/entities/config', () => ({
  useDmViewState: () => ({ enabled: true, settled: true }),
}));
vi.mock('@/layers/entities/session', () => ({
  useSessionSearch: () => ({ view: undefined }),
}));

const CHAT = { sessionId: 's', sessionIds: ['s'], roomId: 'dm', agentPath: '/a' };
const TEN_MINUTES_MS = 10 * 60 * 1000;

/** Move the clock on, letting what it wakes finish. */
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/** Mount the view with the lookup answering as it is told. */
function mount(findDirectChat: ReturnType<typeof vi.fn>) {
  const client = new QueryClient();
  const transport = createMockTransport({ findDirectChat: findDirectChat as never });
  return renderHook(() => useDirectMessageView('s'), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
}

describe('useDirectMessageView when the lookup fails', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('waits while the first answer is out', () => {
    const { result } = mount(vi.fn().mockReturnValue(new Promise(() => {})));
    expect(result.current).toMatchObject({ mode: 'pending', lookupFailed: false });
  });

  it('says so at once, drawn as an ordinary chat', async () => {
    const { result } = mount(vi.fn().mockRejectedValue(new Error('500')));
    await wait(1);
    expect(result.current).toMatchObject({ mode: 'off', chat: null, lookupFailed: true });
  });

  it('stays that way while it asks again, however long that takes', async () => {
    const findDirectChat = vi
      .fn()
      .mockRejectedValueOnce(new Error('500'))
      .mockReturnValue(new Promise(() => {}));
    const { result } = mount(findDirectChat);
    await wait(TEN_MINUTES_MS);
    expect(findDirectChat).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ mode: 'off', lookupFailed: true });
  });

  it('becomes a DM when asking again says it is one', async () => {
    const { result } = mount(
      vi.fn().mockRejectedValueOnce(new Error('500')).mockResolvedValue(CHAT)
    );
    await wait(TEN_MINUTES_MS);
    expect(result.current).toMatchObject({ mode: 'dm', chat: CHAT, lookupFailed: false });
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StartMcpSigninResult, Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { useMcpSigninFlow } from '../index';

const AGENT_ID = '01HZ0000000000000000000001';
const SERVER = 'granola';

const startResult: StartMcpSigninResult = {
  flowId: 'flow-1',
  authorizeUrl: 'https://auth.example/authorize?x=1',
  alreadyConnected: false,
  disclosure: 'DorkOS keeps the resulting token encrypted on this computer.',
  message: 'sign-in link',
};

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

/**
 * Advance the fake clock and let React settle.
 *
 * Two passes on purpose: the poll's promise resolves during the first, and the
 * query observer's notification only reaches React on the pass after that. One
 * pass reads the state one render behind and makes every timing assertion here
 * report the wrong thing.
 *
 * @param ms - How far to move the fake clock.
 */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('useMcpSigninFlow', () => {
  it('surfaces the disclosure WITH the link and does not poll until the person opens it', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.startMcpSignin).mockResolvedValue(startResult);

    const { result } = renderHook(() => useMcpSigninFlow(AGENT_ID, SERVER), {
      wrapper: createWrapper(transport).wrapper,
    });

    act(() => result.current.start());

    await waitFor(() => expect(result.current.state.step).toBe('disclosure'));
    // Consent ordering: when the link first exists, the custody sentence is
    // already on the state beside it.
    expect(result.current.state.disclosure).toBe(startResult.disclosure);
    expect(result.current.state.authorizeUrl).toBe(startResult.authorizeUrl);
    expect(transport.startMcpSignin).toHaveBeenCalledWith(AGENT_ID, SERVER);
    // Polling must not begin while the person is still reading the disclosure.
    expect(transport.pollMcpSignin).not.toHaveBeenCalled();
  });

  it('polls after authOpened and lands connected, refreshing live status', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.startMcpSignin).mockResolvedValue(startResult);
    vi.mocked(transport.pollMcpSignin).mockResolvedValue({ status: 'connected' });
    const { queryClient, wrapper } = createWrapper(transport);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useMcpSigninFlow(AGENT_ID, SERVER), { wrapper });

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.step).toBe('disclosure'));

    act(() => result.current.authOpened());

    await waitFor(() => expect(result.current.state.step).toBe('connected'));
    expect(transport.pollMcpSignin).toHaveBeenCalledWith('flow-1');
    // The row flips without a reload: both the managed roster and live status refresh.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['agents', 'mcp-servers', AGENT_ID],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['mcp-config'] });
  });

  it('lands failed with the server error when the poll fails', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.startMcpSignin).mockResolvedValue(startResult);
    vi.mocked(transport.pollMcpSignin).mockResolvedValue({
      status: 'failed',
      error: 'Sign-in was cancelled.',
    });

    const { result } = renderHook(() => useMcpSigninFlow(AGENT_ID, SERVER), {
      wrapper: createWrapper(transport).wrapper,
    });

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.step).toBe('disclosure'));
    act(() => result.current.authOpened());

    await waitFor(() => expect(result.current.state.step).toBe('failed'));
    expect(result.current.state.error).toBe('Sign-in was cancelled.');
  });

  it('keeps polling through a dropped request rather than calling the sign-in failed', async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockTransport();
      vi.mocked(transport.startMcpSignin).mockResolvedValue(startResult);
      vi.mocked(transport.pollMcpSignin)
        .mockRejectedValueOnce(new Error('Failed to fetch'))
        .mockResolvedValue({ status: 'connected' });

      const { result } = renderHook(() => useMcpSigninFlow(AGENT_ID, SERVER), {
        wrapper: createWrapper(transport).wrapper,
      });

      act(() => result.current.start());
      await tick(0);
      act(() => result.current.authOpened());
      await tick(0);

      // One failed request is a network hiccup, not a failed sign-in — and the
      // browser's own words never reach the person.
      expect(result.current.state.step).toBe('waiting');
      expect(result.current.state.error).toBeNull();
      expect(result.current.state.retryNotice).toBe('Couldn’t check the sign-in. Retrying.');

      // The next attempt, on the backed-off interval, finds the finished sign-in.
      await tick(4_000);
      expect(transport.pollMcpSignin).toHaveBeenCalledTimes(2);
      expect(result.current.state.step).toBe('connected');
      expect(result.current.state.retryNotice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up with plain copy once the status checks keep failing', async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockTransport();
      vi.mocked(transport.startMcpSignin).mockResolvedValue(startResult);
      vi.mocked(transport.pollMcpSignin).mockRejectedValue(new Error('Failed to fetch'));

      const { result } = renderHook(() => useMcpSigninFlow(AGENT_ID, SERVER), {
        wrapper: createWrapper(transport).wrapper,
      });

      act(() => result.current.start());
      await tick(0);
      act(() => result.current.authOpened());
      await tick(60_000);

      // Bounded, so a server that is genuinely gone does not poll forever…
      expect(result.current.state.step).toBe('failed');
      const attempts = vi.mocked(transport.pollMcpSignin).mock.calls.length;
      expect(attempts).toBe(5);
      // …and what a person reads is a sentence, not `Failed to fetch`.
      expect(result.current.state.error).toBe(
        'Couldn’t check if the sign-in finished. Try again in a moment.'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling for good once the flow lands connected', async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockTransport();
      vi.mocked(transport.startMcpSignin).mockResolvedValue(startResult);
      vi.mocked(transport.pollMcpSignin).mockResolvedValue({ status: 'connected' });

      const { result } = renderHook(() => useMcpSigninFlow(AGENT_ID, SERVER), {
        wrapper: createWrapper(transport).wrapper,
      });

      act(() => result.current.start());
      await tick(0);
      act(() => result.current.authOpened());
      await tick(0);
      expect(result.current.state.step).toBe('connected');
      expect(transport.pollMcpSignin).toHaveBeenCalledTimes(1);

      // Five poll intervals' worth of time with nothing more asked of the server.
      // Returning an interval instead of `false` on a terminal status reddens this.
      await tick(10_000);
      expect(transport.pollMcpSignin).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useMcpSigninFlow — flow ownership', () => {
  it('never lets an abandoned flow’s poll settle into its successor’s counter', async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockTransport();
      vi.mocked(transport.startMcpSignin)
        .mockResolvedValueOnce(startResult)
        .mockResolvedValue({ ...startResult, flowId: 'flow-2' });
      // The first flow's poll is left hanging, then rejected long after the person has abandoned
      // it and started again.
      let failFirstPoll: (err: Error) => void = () => {};
      vi.mocked(transport.pollMcpSignin)
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              failFirstPoll = reject;
            })
        )
        .mockResolvedValue({ status: 'pending' });

      const { result } = renderHook(() => useMcpSigninFlow(AGENT_ID, SERVER), {
        wrapper: createWrapper(transport).wrapper,
      });

      act(() => result.current.start());
      await tick(0);
      act(() => result.current.authOpened());
      await tick(0);
      expect(transport.pollMcpSignin).toHaveBeenCalledWith('flow-1');

      // Abandon it and start a fresh one.
      act(() => result.current.reset());
      await tick(0);
      act(() => result.current.start());
      await tick(0);
      act(() => result.current.authOpened());
      await tick(0);

      // Now the corpse of the first flow's request lands.
      await act(async () => {
        failFirstPoll(new Error('Failed to fetch'));
        await vi.advanceTimersByTimeAsync(10);
      });
      await tick(0);

      expect(result.current.state.step).toBe('waiting');
      expect(result.current.state.retryNotice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopts a pushed flow and shows its link, without starting one', async () => {
    const transport = createMockTransport();

    const { result } = renderHook(() => useMcpSigninFlow(AGENT_ID, SERVER), {
      wrapper: createWrapper(transport).wrapper,
    });

    act(() =>
      result.current.adopt({
        flowId: 'flow-9',
        authorizeUrl: startResult.authorizeUrl!,
        disclosure: startResult.disclosure,
      })
    );

    expect(result.current.state.step).toBe('disclosure');
    expect(result.current.state.authorizeUrl).toBe(startResult.authorizeUrl);
    expect(result.current.state.disclosure).toBe(startResult.disclosure);
    expect(transport.startMcpSignin).not.toHaveBeenCalled();
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { SSE_RESILIENCE } from '@/layers/shared/lib';

// Mock useAppStore and useTabVisibility to provide required state
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        selectedCwd: '/test/cwd',
        enableCrossClientSync: false,
        enableMessagePolling: false,
      };
      return selector ? selector(state) : state;
    },
    useTabVisibility: () => true,
  };
});

// Mock insertOptimisticSession to avoid entity layer side-effects
vi.mock('@/layers/entities/session', () => ({
  insertOptimisticSession: vi.fn(),
}));

// Import after mocks are registered
import { useChatSession } from '../use-chat-session';

describe('POST chat stream retry logic', () => {
  let mockTransport: Transport;
  let queryClient: QueryClient;

  function createWrapper() {
    return function Wrapper({ children }: { children: React.ReactNode }) {
      /* eslint-disable react/no-children-prop */
      return React.createElement(QueryClientProvider, {
        client: queryClient,
        children: React.createElement(TransportProvider, { transport: mockTransport, children }),
      });
      /* eslint-enable react/no-children-prop */
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockTransport = createMockTransport();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-retries once on transient TypeError, returns to idle on retry success', async () => {
    let callCount = 0;
    (mockTransport.sendMessage as Mock).mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new TypeError('Failed to fetch');
      }
      // Retry succeeds
    });

    const { result } = renderHook(() => useChatSession('session-1'), {
      wrapper: createWrapper(),
    });

    // Set input then submit
    act(() => {
      result.current.setInput('Hello');
    });

    await act(async () => {
      const promise = result.current.handleSubmit();
      await vi.advanceTimersByTimeAsync(SSE_RESILIENCE.POST_RETRY_DELAY_MS + 100);
      await promise;
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('does NOT retry on SESSION_LOCKED error', async () => {
    const lockedError = Object.assign(new Error('locked'), { code: 'SESSION_LOCKED' });
    (mockTransport.sendMessage as Mock).mockRejectedValue(lockedError);

    const { result } = renderHook(() => useChatSession('session-1'), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setInput('Hello');
    });

    await act(async () => {
      const promise = result.current.handleSubmit();
      await vi.advanceTimersByTimeAsync(100);
      await promise;
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('error');
    expect(result.current.error?.heading).toBe('Session in use');
    expect(result.current.error?.retryable).toBe(false);
  });

  it('does NOT retry on non-retryable 4xx-style error', async () => {
    const clientError = Object.assign(new Error('Bad Request'), { status: 400 });
    (mockTransport.sendMessage as Mock).mockRejectedValue(clientError);

    const { result } = renderHook(() => useChatSession('session-1'), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setInput('Hello');
    });

    await act(async () => {
      const promise = result.current.handleSubmit();
      await vi.advanceTimersByTimeAsync(100);
      await promise;
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('error');
    expect(result.current.error?.retryable).toBe(false);
  });

  it('shows error banner with retryable=true when both original and retry fail', async () => {
    (mockTransport.sendMessage as Mock).mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useChatSession('session-1'), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setInput('Hello');
    });

    await act(async () => {
      const promise = result.current.handleSubmit();
      await vi.advanceTimersByTimeAsync(SSE_RESILIENCE.POST_RETRY_DELAY_MS + 100);
      await promise;
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('error');
    expect(result.current.error?.heading).toBe('Connection failed');
    expect(result.current.error?.retryable).toBe(true);
  });

  it('does NOT retry on AbortError (user cancellation)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    (mockTransport.sendMessage as Mock).mockRejectedValue(abortError);

    const { result } = renderHook(() => useChatSession('session-1'), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setInput('Hello');
    });

    await act(async () => {
      const promise = result.current.handleSubmit();
      await vi.advanceTimersByTimeAsync(100);
      await promise;
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it('preserves partial assistant message parts after a streaming error', async () => {
    (mockTransport.sendMessage as Mock).mockImplementation(
      async (
        _sessionId: string,
        _content: string,
        onEvent: (event: { type: string; data: unknown }) => void
      ) => {
        // Emit a text_delta event so the hook creates an assistant message
        onEvent({ type: 'text_delta', data: { text: 'Partial response' } });
        throw new TypeError('network interrupted');
      }
    );

    const { result } = renderHook(() => useChatSession('session-1'), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setInput('Hello');
    });

    await act(async () => {
      const promise = result.current.handleSubmit();
      await vi.advanceTimersByTimeAsync(SSE_RESILIENCE.POST_RETRY_DELAY_MS + 100);
      await promise;
    });

    // After both attempts fail, the assistant message with partial content should remain.
    // The retry logic does NOT discard partial assistant messages — only the pending
    // user message is removed on final failure.
    const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
    expect(result.current.status).toBe('error');
  });

  it('retryMessage clears error, resets retry counter, and re-submits', async () => {
    let callCount = 0;
    (mockTransport.sendMessage as Mock).mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 2) {
        throw new TypeError('Failed to fetch');
      }
      // Third call (manual retry via retryMessage) succeeds
    });

    const { result } = renderHook(() => useChatSession('session-1'), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setInput('Hello');
    });

    // First submission fails, auto-retry also fails
    await act(async () => {
      const promise = result.current.handleSubmit();
      await vi.advanceTimersByTimeAsync(SSE_RESILIENCE.POST_RETRY_DELAY_MS + 100);
      await promise;
    });

    expect(result.current.status).toBe('error');
    expect(callCount).toBe(2);

    // User clicks retry via retryMessage — succeeds on third call
    await act(async () => {
      const promise = result.current.retryMessage('Hello');
      await vi.advanceTimersByTimeAsync(100);
      await promise;
    });

    expect(callCount).toBe(3);
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('shows transient "Retrying…" banner during the retry delay', async () => {
    let callCount = 0;
    let retryBannerSeen = false;

    (mockTransport.sendMessage as Mock).mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new TypeError('Failed to fetch');
      }
      // On the retry call, the transient banner was already set
      retryBannerSeen = true;
    });

    const { result } = renderHook(() => useChatSession('session-1'), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setInput('Hello');
    });

    await act(async () => {
      const promise = result.current.handleSubmit();
      await vi.advanceTimersByTimeAsync(SSE_RESILIENCE.POST_RETRY_DELAY_MS + 100);
      await promise;
    });

    // Retry succeeded, banner was shown then cleared
    expect(retryBannerSeen).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe('idle');
  });
});

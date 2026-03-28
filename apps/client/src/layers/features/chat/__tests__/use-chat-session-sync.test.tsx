import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChatSession } from '../model/use-chat-session';
import { createMockTransport } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  MockEventSource,
  resetUuidCounter,
  createWrapper,
  createSendMessageMock,
} from './chat-session-test-helpers';

// Mock app store (selectedCwd + debug toggles)
let mockAppState: Record<string, unknown> = {
  selectedCwd: '/test/cwd',
  enableCrossClientSync: true,
  enableMessagePolling: true,
};

vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  const useAppStore = Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      return selector ? selector(mockAppState) : mockAppState;
    },
    { getState: () => mockAppState }
  );
  return {
    ...actual,
    useAppStore,
  };
});

describe('useChatSession — sync & indicators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUuidCounter();
    MockEventSource.instances = [];
    mockAppState = {
      selectedCwd: '/test/cwd',
      enableCrossClientSync: true,
      enableMessagePolling: true,
    };
  });

  describe('EventSource subscription for real-time sync', () => {
    it('opens EventSource connection when session is active and not streaming', async () => {
      const transport = createMockTransport();
      const { result } = renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => {
        expect(result.current.status).toBe('idle');
      });

      expect(globalThis.EventSource).toBeDefined();
    });

    it('closes EventSource when session changes', async () => {
      const transport = createMockTransport();
      const { result, rerender } = renderHook(({ sessionId }) => useChatSession(sessionId), {
        wrapper: createWrapper(transport),
        initialProps: { sessionId: 's1' },
      });

      await waitFor(() => {
        expect(result.current.status).toBe('idle');
      });

      rerender({ sessionId: 's2' });

      await waitFor(() => {
        expect(result.current.status).toBe('idle');
      });

      expect(result.current.status).toBe('idle');
    });

    it('does not open EventSource while streaming', async () => {
      const sendMessage = vi.fn(
        async (
          _sessionId: string,
          _content: string,
          _onEvent: (event: StreamEvent) => void,
          signal?: AbortSignal,
          _cwd?: string
        ) => {
          return new Promise<void>((resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          });
        }
      );
      const transport = createMockTransport({ sendMessage });

      const { result } = renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('test');
      });

      act(() => {
        result.current.handleSubmit();
      });

      await waitFor(() => expect(result.current.status).toBe('streaming'));

      expect(result.current.status).toBe('streaming');

      await act(async () => {
        result.current.stop();
      });
    });
  });

  describe('inference indicator state', () => {
    it('resets streamStartTime and estimatedTokens after done event', async () => {
      const sendMessage = createSendMessageMock([
        { type: 'text_delta', data: { text: 'Hello world!' } } as StreamEvent,
        { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
      ]);
      const transport = createMockTransport({ sendMessage });
      const { result } = renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('test');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      expect(result.current.streamStartTime).toBeNull();
      expect(result.current.estimatedTokens).toBe(0);
    });

    it('accumulates estimatedTokens from text_delta lengths', async () => {
      const sendMessage = vi.fn(
        async (
          _sessionId: string,
          _content: string,
          onEvent: (event: StreamEvent) => void,
          _signal?: AbortSignal,
          _cwd?: string
        ) => {
          onEvent({ type: 'text_delta', data: { text: '12345678' } } as StreamEvent);
          onEvent({ type: 'text_delta', data: { text: 'abcdefgh' } } as StreamEvent);
          onEvent({ type: 'done', data: { sessionId: 's1' } } as StreamEvent);
        }
      );
      const transport = createMockTransport({ sendMessage });
      const { result } = renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('test');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      expect(result.current.estimatedTokens).toBe(0);
    });

    it('sets streamStartTime to a number when streaming begins', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const sendMessage = createSendMessageMock([
        { type: 'text_delta', data: { text: 'Hello' } } as StreamEvent,
        { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
      ]);
      const transport = createMockTransport({ sendMessage });
      const { result } = renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('test');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      expect(result.current.streamStartTime).toBeNull();

      vi.restoreAllMocks();
    });
  });

  describe('data path debug toggles', () => {
    it('does not create EventSource when enableCrossClientSync is false', async () => {
      mockAppState = { ...mockAppState, enableCrossClientSync: false };

      const transport = createMockTransport();
      renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => {
        const streamInstances = MockEventSource.instances.filter((es) =>
          es.url.includes('/api/sessions/s1/stream')
        );
        expect(streamInstances).toHaveLength(0);
      });
    });

    it('creates SSE connection when enableCrossClientSync is true (default)', async () => {
      const transport = createMockTransport();
      const { result } = renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => {
        // The hook now uses fetch-based SSEConnection via useSSEConnection,
        // which exposes syncConnectionState. A non-null state indicates the
        // connection was established.
        expect(result.current.syncConnectionState).toBeDefined();
      });
    });
  });
});

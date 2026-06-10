import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChatSession } from '../model/use-chat-session';
import { createMockTransport } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  resetUuidCounter,
  createWrapper,
  createSendMessageMock,
} from './chat-session-test-helpers';

// Mock app store (selectedCwd + background-refresh toggle). Cross-client sync is
// now always-on (spec chat-stream-reconnection, ADR-0266) — no flag.
let mockAppState: Record<string, unknown> = {
  selectedCwd: '/test/cwd',
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
    mockAppState = {
      selectedCwd: '/test/cwd',
      enableMessagePolling: true,
    };
  });

  describe('connection indicator', () => {
    // The connection indicator is now sourced from the always-on durable
    // `/events` stream (StreamManager `ConnectionState`), replacing the retired
    // flag-gated sync stream's connection state.
    it('exposes a defined syncConnectionState sourced from the durable stream', async () => {
      const transport = createMockTransport();
      const { result } = renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => {
        expect(result.current.syncConnectionState).toBeDefined();
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
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChatSession } from '../model/use-chat-session';
import { createMockTransport } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  MockEventSource,
  resetUuidCounter,
  createWrapper,
  createWrapperWithClient,
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
  return {
    ...actual,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      return selector ? selector(mockAppState) : mockAppState;
    },
  };
});

describe('useChatSession — core', () => {
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

  it('initializes with empty messages and transitions to idle', async () => {
    const transport = createMockTransport();
    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.input).toBe('');
  });

  it('loads history messages on mount', async () => {
    const transport = createMockTransport({
      getMessages: vi.fn().mockResolvedValue({
        messages: [
          { id: 'h1', role: 'user', content: 'Previous question' },
          {
            id: 'h2',
            role: 'assistant',
            content: 'Previous answer',
            toolCalls: [{ toolCallId: 'tc1', toolName: 'Read', status: 'complete' }],
          },
        ],
      }),
    });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });

    expect(result.current.messages[0].content).toBe('Previous question');
    expect(result.current.messages[1].content).toBe('Previous answer');
    expect(result.current.messages[1].toolCalls).toHaveLength(1);
    expect(result.current.messages[1].toolCalls![0].toolName).toBe('Read');
    expect(result.current.isLoadingHistory).toBe(false);
  });

  it('ignores empty input on submit', async () => {
    const transport = createMockTransport();
    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('   ');
      await result.current.handleSubmit();
    });

    expect(result.current.messages).toEqual([]);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('adds optimistic user message to messages on submit and clears input', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('Hello');
    });

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.input).toBe('');
    const userMessages = result.current.messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe('Hello');
  });

  it('parses text_delta events into assistant message content', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'text_delta', data: { text: 'Hello ' } } as StreamEvent,
      { type: 'text_delta', data: { text: 'World' } } as StreamEvent,
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('Hi');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Hello World');
  });

  it('handles tool_call_start -> tool_call_delta -> tool_call_end lifecycle', async () => {
    const sendMessage = createSendMessageMock([
      {
        type: 'tool_call_start',
        data: { toolCallId: 'tc1', toolName: 'Read', status: 'running' },
      } as StreamEvent,
      {
        type: 'tool_call_delta',
        data: { toolCallId: 'tc1', toolName: 'Read', input: '{"path": "/foo"}', status: 'running' },
      } as StreamEvent,
      {
        type: 'tool_call_end',
        data: { toolCallId: 'tc1', toolName: 'Read', status: 'complete' },
      } as StreamEvent,
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('Read file');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.toolCalls).toHaveLength(1);
    expect(assistantMsg?.toolCalls![0].toolName).toBe('Read');
    expect(assistantMsg?.toolCalls![0].status).toBe('complete');
    expect(assistantMsg?.toolCalls![0].input).toBe('{"path": "/foo"}');
  });

  it('handles tool_result events', async () => {
    const sendMessage = createSendMessageMock([
      {
        type: 'tool_call_start',
        data: { toolCallId: 'tc1', toolName: 'Read', status: 'running' },
      } as StreamEvent,
      {
        type: 'tool_result',
        data: { toolCallId: 'tc1', toolName: 'Read', result: 'file contents', status: 'complete' },
      } as StreamEvent,
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('Read');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.toolCalls![0].result).toBe('file contents');
    expect(assistantMsg?.toolCalls![0].status).toBe('complete');
  });

  it('sets error message on error events', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'error', data: { message: 'Something went wrong' } } as StreamEvent,
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('fail');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.error).toMatchObject({ message: 'Something went wrong' });
  });

  it('returns to idle on done events', async () => {
    const sendMessage = createSendMessageMock([
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

    expect(result.current.status).toBe('idle');
  });

  it('stop() aborts the stream', async () => {
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

    await act(async () => {
      result.current.stop();
    });

    expect(result.current.status).toBe('idle');
  });

  it('handles sendMessage errors', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('HTTP 404'));
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

    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatchObject({ message: 'HTTP 404' });
    expect(result.current.messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('handles SESSION_LOCKED errors by setting sessionBusy and preserving input', async () => {
    const lockedError = new Error('Session locked') as Error & { code: string };
    lockedError.code = 'SESSION_LOCKED';
    const sendMessage = vi.fn().mockRejectedValue(lockedError);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('test message');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.sessionBusy).toBe(true);
    expect(result.current.input).toBe('test message');
    expect(result.current.error).toMatchObject({ heading: 'Session in use' });
    expect(result.current.status).toBe('error');
  });

  it('calls transport.sendMessage with correct arguments', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('Hello');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(sendMessage).toHaveBeenCalledWith(
      's1',
      'Hello',
      expect.any(Function),
      expect.any(AbortSignal),
      '/test/cwd',
      expect.objectContaining({ clientMessageId: expect.any(String) })
    );
  });

  it('appends new messages after history', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'text_delta', data: { text: 'New reply' } } as StreamEvent,
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({
      getMessages: vi.fn().mockResolvedValue({
        messages: [
          { id: 'h1', role: 'user', content: 'Old message' },
          { id: 'h2', role: 'assistant', content: 'Old reply' },
        ],
      }),
      sendMessage,
    });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });

    await act(async () => {
      result.current.setInput('New question');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.messages).toHaveLength(4);
    expect(result.current.messages[2].role).toBe('user');
    expect(result.current.messages[2].content).toBe('New question');
    expect(result.current.messages[3].role).toBe('assistant');
    expect(result.current.messages[3].content).toBe('New reply');
  });

  describe('deferred assistant message creation', () => {
    it('does not create assistant message immediately on submit', async () => {
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

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.messages[0].content).toBe('test');

      await act(async () => {
        result.current.stop();
      });
    });

    it('creates assistant message on first text_delta', async () => {
      const sendMessage = createSendMessageMock([
        { type: 'text_delta', data: { text: 'Hello from Claude' } } as StreamEvent,
        { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
      ]);
      const transport = createMockTransport({ sendMessage });

      const { result } = renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('Hi');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.messages[1].role).toBe('assistant');
      expect(result.current.messages[1].content).toBe('Hello from Claude');
    });

    it('optimistic user message appears before assistant during streaming', async () => {
      let fireEvents!: (events: StreamEvent[]) => void;
      const sendMessage = vi.fn(
        (
          _sessionId: string,
          _content: string,
          onEvent: (event: StreamEvent) => void,
          signal?: AbortSignal
        ) => {
          fireEvents = (events: StreamEvent[]) => {
            for (const event of events) onEvent(event);
          };
          return new Promise<void>((resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
            (sendMessage as unknown as { _resolve: () => void })._resolve = resolve;
          });
        }
      );
      const transport = createMockTransport({ sendMessage });

      const { result } = renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('Hello');
      });

      act(() => {
        result.current.handleSubmit();
      });

      await waitFor(() => expect(result.current.status).toBe('streaming'));

      act(() => {
        fireEvents([{ type: 'text_delta', data: { text: 'Response' } } as StreamEvent]);
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.messages[0].content).toBe('Hello');
      expect(result.current.messages[1].role).toBe('assistant');
      expect(result.current.messages[1].content).toBe('Response');

      await act(async () => {
        result.current.stop();
      });
    });

    it('creates assistant message on first tool_call_start', async () => {
      const sendMessage = createSendMessageMock([
        {
          type: 'tool_call_start',
          data: { toolCallId: 'tc1', toolName: 'Read', status: 'running' },
        } as StreamEvent,
        { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
      ]);
      const transport = createMockTransport({ sendMessage });

      const { result } = renderHook(() => useChatSession('s1'), {
        wrapper: createWrapper(transport),
      });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('Read file');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.messages[1].role).toBe('assistant');
      expect(result.current.messages[1].toolCalls).toHaveLength(1);
      expect(result.current.messages[1].toolCalls![0].toolName).toBe('Read');
    });

    it('does not create duplicate assistant messages on subsequent events', async () => {
      const sendMessage = createSendMessageMock([
        { type: 'text_delta', data: { text: 'First ' } } as StreamEvent,
        { type: 'text_delta', data: { text: 'Second' } } as StreamEvent,
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

      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toBe('First Second');
    });

    it('handles done without content gracefully', async () => {
      const sendMessage = createSendMessageMock([
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

      const userMessages = result.current.messages.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].content).toBe('test');
      expect(result.current.status).toBe('idle');
    });
  });

  describe('speculative UUID optimistic insert', () => {
    it('inserts optimistic session on first message for speculative UUID', async () => {
      const sendMessage = createSendMessageMock([
        { type: 'done', data: { sessionId: 'spec-uuid' } } as StreamEvent,
      ]);
      const transport = createMockTransport({ sendMessage });
      const { wrapper, queryClient } = createWrapperWithClient(transport);

      const { result } = renderHook(() => useChatSession('spec-uuid'), {
        wrapper,
      });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('Hello');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      // Session should now exist in the sessions cache
      const sessions = queryClient.getQueryData<Array<{ id: string }>>(['sessions', '/test/cwd']);
      expect(sessions).toBeDefined();
      expect(sessions!.some((s) => s.id === 'spec-uuid')).toBe(true);
    });

    it('skips optimistic insert when session already exists in cache', async () => {
      const sendMessage = createSendMessageMock([
        { type: 'done', data: { sessionId: 'existing-id' } } as StreamEvent,
      ]);
      const transport = createMockTransport({ sendMessage });
      const { wrapper, queryClient } = createWrapperWithClient(transport);

      // Pre-populate session cache
      queryClient.setQueryData(
        ['sessions', '/test/cwd'],
        [
          {
            id: 'existing-id',
            title: 'Existing session',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            permissionMode: 'default',
          },
        ]
      );

      const { result } = renderHook(() => useChatSession('existing-id'), {
        wrapper,
      });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('Hello');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      // Should still have exactly one session (no duplicate inserted)
      const sessions = queryClient.getQueryData<Array<{ id: string }>>(['sessions', '/test/cwd']);
      expect(sessions).toHaveLength(1);
      expect(sessions![0].id).toBe('existing-id');
    });
  });
});

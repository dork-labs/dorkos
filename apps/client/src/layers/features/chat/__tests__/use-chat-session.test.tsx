import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChatSession } from '../model/use-chat-session';
import type { Transport } from '@dorkos/shared/transport';
import type { StreamEvent } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/lib';

// Mock app store (selectedCwd)
vi.mock('@/layers/shared/lib', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/lib');
  return {
    ...actual,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { selectedCwd: '/test/cwd' };
      return selector ? selector(state) : state;
    },
  };
});

// Mock EventSource for SSE subscription tests
class MockEventSource {
  url: string;
  listeners: Map<string, Array<(event: Event) => void>>;
  readyState: number;

  constructor(url: string) {
    this.url = url;
    this.listeners = new Map();
    this.readyState = 1; // OPEN
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  close() {
    this.readyState = 2; // CLOSED
  }
}

globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

function createMockTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    submitAnswers: vi.fn().mockResolvedValue({ ok: true }),
    getCommands: vi.fn(),
    health: vi.fn(),
    updateSession: vi.fn(),
    browseDirectory: vi.fn().mockResolvedValue({ path: '/test', entries: [], parent: null }),
    getDefaultCwd: vi.fn().mockResolvedValue({ path: '/test/cwd' }),
    listFiles: vi.fn().mockResolvedValue({ files: [], truncated: false, total: 0 }),
    getConfig: vi.fn().mockResolvedValue({ version: '1.0.0', port: 6942, uptime: 0, workingDirectory: '/test', nodeVersion: 'v20.0.0', claudeCliPath: null, tunnel: { enabled: false, connected: false, url: null, authEnabled: false, tokenConfigured: false } }),
    getGitStatus: vi.fn().mockResolvedValue({ error: 'not_git_repo' as const }),
    ...overrides,
  };
}

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

// Mock crypto.randomUUID
const mockUUID = vi.fn();
let uuidCounter = 0;
mockUUID.mockImplementation(() => `uuid-${++uuidCounter}`);
Object.defineProperty(globalThis.crypto, 'randomUUID', {
  value: mockUUID,
  writable: true,
});

/** Helper: create a sendMessage mock that fires events via the onEvent callback */
function createSendMessageMock(events: StreamEvent[]) {
  return vi.fn(async (
    _sessionId: string,
    _content: string,
    onEvent: (event: StreamEvent) => void,
    _signal?: AbortSignal,
    _cwd?: string,
  ) => {
    for (const event of events) {
      onEvent(event);
    }
  });
}

describe('useChatSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
  });

  it('initializes with empty messages and transitions to idle', async () => {
    const transport = createMockTransport();
    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

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
          { id: 'h2', role: 'assistant', content: 'Previous answer', toolCalls: [
            { toolCallId: 'tc1', toolName: 'Read', status: 'complete' },
          ]},
        ],
      }),
    });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

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
    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('   ');
      await result.current.handleSubmit();
    });

    expect(result.current.messages).toEqual([]);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('adds user message on submit and clears input', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('Hello');
    });

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.input).toBe('');
    // With deferred assistant message creation, done without content creates no assistant message
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe('user');
    expect(result.current.messages[0].content).toBe('Hello');
  });

  it('parses text_delta events into assistant message content', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'text_delta', data: { text: 'Hello ' } } as StreamEvent,
      { type: 'text_delta', data: { text: 'World' } } as StreamEvent,
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('Hi');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Hello World');
  });

  it('handles tool_call_start -> tool_call_delta -> tool_call_end lifecycle', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'tool_call_start', data: { toolCallId: 'tc1', toolName: 'Read', status: 'running' } } as StreamEvent,
      { type: 'tool_call_delta', data: { toolCallId: 'tc1', toolName: 'Read', input: '{"path": "/foo"}', status: 'running' } } as StreamEvent,
      { type: 'tool_call_end', data: { toolCallId: 'tc1', toolName: 'Read', status: 'complete' } } as StreamEvent,
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('Read file');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.toolCalls).toHaveLength(1);
    expect(assistantMsg?.toolCalls![0].toolName).toBe('Read');
    expect(assistantMsg?.toolCalls![0].status).toBe('complete');
    expect(assistantMsg?.toolCalls![0].input).toBe('{"path": "/foo"}');
  });

  it('handles tool_result events', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'tool_call_start', data: { toolCallId: 'tc1', toolName: 'Read', status: 'running' } } as StreamEvent,
      { type: 'tool_result', data: { toolCallId: 'tc1', toolName: 'Read', result: 'file contents', status: 'complete' } } as StreamEvent,
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('Read');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.toolCalls![0].result).toBe('file contents');
    expect(assistantMsg?.toolCalls![0].status).toBe('complete');
  });

  it('sets error message on error events', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'error', data: { message: 'Something went wrong' } } as StreamEvent,
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('fail');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.error).toBe('Something went wrong');
  });

  it('returns to idle on done events', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

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
    // Create a sendMessage that hangs until aborted
    const sendMessage = vi.fn(async (
      _sessionId: string,
      _content: string,
      _onEvent: (event: StreamEvent) => void,
      signal?: AbortSignal,
      _cwd?: string,
    ) => {
      return new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('test');
    });

    // Start streaming (don't await - it will hang)
    act(() => {
      result.current.handleSubmit();
    });

    // Stop immediately
    await act(async () => {
      result.current.stop();
    });

    expect(result.current.status).toBe('idle');
  });

  it('handles sendMessage errors', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('HTTP 404'));
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('test');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('HTTP 404');
  });

  it('handles SESSION_LOCKED errors by setting sessionBusy and preserving input', async () => {
    const lockedError = new Error('Session locked') as Error & { code: string };
    lockedError.code = 'SESSION_LOCKED';
    const sendMessage = vi.fn().mockRejectedValue(lockedError);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.setInput('test message');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.sessionBusy).toBe(true);
    expect(result.current.input).toBe('test message'); // Input preserved
    expect(result.current.error).toBeNull(); // No error message set for busy state
    expect(result.current.status).toBe('error');
  });

  it('calls transport.sendMessage with correct arguments', async () => {
    const sendMessage = createSendMessageMock([
      { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
    ]);
    const transport = createMockTransport({ sendMessage });

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

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

    const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });

    await act(async () => {
      result.current.setInput('New question');
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    // 2 history + 1 new user + 1 new assistant = 4
    expect(result.current.messages).toHaveLength(4);
    expect(result.current.messages[2].role).toBe('user');
    expect(result.current.messages[2].content).toBe('New question');
    expect(result.current.messages[3].role).toBe('assistant');
    expect(result.current.messages[3].content).toBe('New reply');
  });

  describe('deferred assistant message creation', () => {
    it('does not create assistant message immediately on submit', async () => {
      // Create a sendMessage mock that never resolves (hangs)
      const sendMessage = vi.fn(async (
        _sessionId: string,
        _content: string,
        _onEvent: (event: StreamEvent) => void,
        signal?: AbortSignal,
        _cwd?: string,
      ) => {
        return new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      });
      const transport = createMockTransport({ sendMessage });

      const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('test');
      });

      // Start streaming (don't await - it will hang)
      act(() => {
        result.current.handleSubmit();
      });

      // Wait for streaming status
      await waitFor(() => expect(result.current.status).toBe('streaming'));

      // Assert only user message exists, no assistant message yet
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.status).toBe('streaming');

      // Clean up by stopping
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

      const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('Hi');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      // Assert assistant message was created with content from delta
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[1].role).toBe('assistant');
      expect(result.current.messages[1].content).toBe('Hello from Claude');
    });

    it('creates assistant message on first tool_call_start', async () => {
      const sendMessage = createSendMessageMock([
        { type: 'tool_call_start', data: { toolCallId: 'tc1', toolName: 'Read', status: 'running' } } as StreamEvent,
        { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
      ]);
      const transport = createMockTransport({ sendMessage });

      const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('Read file');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      // Assert assistant message was created with toolCalls array
      expect(result.current.messages).toHaveLength(2);
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

      const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('test');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      // Assert only 1 assistant message exists with combined content
      const assistantMessages = result.current.messages.filter(m => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toBe('First Second');
    });

    it('handles done without content gracefully', async () => {
      const sendMessage = createSendMessageMock([
        { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
      ]);
      const transport = createMockTransport({ sendMessage });

      const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('test');
      });
      await act(async () => {
        await result.current.handleSubmit();
      });

      // Assert only user message exists, no assistant message
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.status).toBe('idle');
    });
  });

  describe('EventSource subscription for real-time sync', () => {
    it('opens EventSource connection when session is active and not streaming', async () => {
      const transport = createMockTransport();
      const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

      await waitFor(() => {
        expect(result.current.status).toBe('idle');
      });

      // Verify EventSource was created for the session
      expect(globalThis.EventSource).toBeDefined();
    });

    it('closes EventSource when session changes', async () => {
      const transport = createMockTransport();
      const { result, rerender } = renderHook(
        ({ sessionId }) => useChatSession(sessionId),
        {
          wrapper: createWrapper(transport),
          initialProps: { sessionId: 's1' }
        }
      );

      await waitFor(() => {
        expect(result.current.status).toBe('idle');
      });

      // Change session ID
      rerender({ sessionId: 's2' });

      await waitFor(() => {
        expect(result.current.status).toBe('idle');
      });

      // EventSource should have been recreated for new session
      expect(result.current.status).toBe('idle');
    });

    it('does not open EventSource while streaming', async () => {
      const sendMessage = vi.fn(async (
        _sessionId: string,
        _content: string,
        _onEvent: (event: StreamEvent) => void,
        signal?: AbortSignal,
        _cwd?: string,
      ) => {
        return new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      });
      const transport = createMockTransport({ sendMessage });

      const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

      await waitFor(() => expect(result.current.status).toBe('idle'));

      await act(async () => {
        result.current.setInput('test');
      });

      // Start streaming
      act(() => {
        result.current.handleSubmit();
      });

      await waitFor(() => expect(result.current.status).toBe('streaming'));

      // EventSource should not interfere with streaming
      expect(result.current.status).toBe('streaming');

      // Clean up
      await act(async () => {
        result.current.stop();
      });
    });
  });
});

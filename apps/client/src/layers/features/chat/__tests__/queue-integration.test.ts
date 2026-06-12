// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMessageQueue } from '../model/use-message-queue';
import type { ChatStatus } from '../model/chat-types';
import { useSessionStreamStore } from '@/layers/entities/session';

describe('Queue workflow integration', () => {
  const onFlush = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // The queue lives in the per-session stream store now (DOR-81); reset it so
    // queue state cannot leak between tests sharing the same session id.
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  });

  it('full workflow: queue during streaming, auto-flush on idle', () => {
    const { result, rerender } = renderHook(
      ({ status }) =>
        useMessageQueue({
          status,
          sessionBusy: false,
          sessionId: 'test',
          selectedCwd: '/dir',
          onFlush,
        }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    act(() => {
      result.current.addToQueue('First followup');
    });
    act(() => {
      result.current.addToQueue('Second followup');
    });
    expect(result.current.queue).toHaveLength(2);

    rerender({ status: 'idle' as const });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      expect.stringContaining(
        '[Note: This message was composed while the agent was responding to the previous message]'
      ),
      'test'
    );
    expect(onFlush).toHaveBeenCalledWith(expect.stringContaining('First followup'), 'test');
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].content).toBe('Second followup');
  });

  it('auto-flush includes exact timing annotation format', () => {
    const { result, rerender } = renderHook(
      ({ status }) =>
        useMessageQueue({
          status,
          sessionBusy: false,
          sessionId: 'test',
          selectedCwd: '/dir',
          onFlush,
        }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    act(() => {
      result.current.addToQueue('My message');
    });
    rerender({ status: 'idle' as const });

    const flushedContent = onFlush.mock.calls[0][0] as string;
    expect(flushedContent).toBe(
      '[Note: This message was composed while the agent was responding to the previous message]\n\nMy message'
    );
  });

  it('arrow key navigation cycles through queue items with draft preservation', () => {
    const { result } = renderHook(() =>
      useMessageQueue({
        status: 'streaming',
        sessionBusy: false,
        sessionId: 'test',
        selectedCwd: '/dir',
        onFlush,
      })
    );

    act(() => {
      result.current.addToQueue('First');
    });
    act(() => {
      result.current.addToQueue('Second');
    });

    let content: string;
    act(() => {
      content = result.current.startEditing(1);
    });
    expect(content!).toBe('Second');
    expect(result.current.editingIndex).toBe(1);

    act(() => {
      content = result.current.startEditing(0);
    });
    expect(content!).toBe('First');
    expect(result.current.editingIndex).toBe(0);

    act(() => {
      result.current.cancelEditing();
    });
    expect(result.current.editingIndex).toBeNull();
  });

  it('editing queue item and saving preserves changes', () => {
    const { result } = renderHook(() =>
      useMessageQueue({
        status: 'streaming',
        sessionBusy: false,
        sessionId: 'test',
        selectedCwd: '/dir',
        onFlush,
      })
    );

    act(() => {
      result.current.addToQueue('Original content');
    });
    act(() => {
      result.current.startEditing(0);
    });
    act(() => {
      result.current.saveEditing('Modified content');
    });

    expect(result.current.queue[0].content).toBe('Modified content');
    expect(result.current.editingIndex).toBeNull();
  });

  it('switching session shows the new session empty queue (origin queue stays pinned)', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useMessageQueue({
          status: 'streaming',
          sessionBusy: false,
          sessionId,
          selectedCwd: '/dir',
          onFlush,
        }),
      { initialProps: { sessionId: 'session-a' } }
    );

    act(() => {
      result.current.addToQueue('Queued msg');
    });
    expect(result.current.queue).toHaveLength(1);

    rerender({ sessionId: 'session-b' });

    // B's queue is empty and the editing cursor reset; A's queue is NOT discarded
    // — it stays pinned to A in the per-session store (DOR-81).
    expect(result.current.queue).toHaveLength(0);
    expect(result.current.editingIndex).toBeNull();
    expect(useSessionStreamStore.getState().getSession('session-a').queuedMessages).toHaveLength(1);
  });

  it('auto-flush skips item being edited and flushes next', () => {
    const { result, rerender } = renderHook(
      ({ status }) =>
        useMessageQueue({
          status,
          sessionBusy: false,
          sessionId: 'test',
          selectedCwd: '/dir',
          onFlush,
        }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    act(() => {
      result.current.addToQueue('Being edited');
    });
    act(() => {
      result.current.addToQueue('Should flush');
    });
    act(() => {
      result.current.startEditing(0);
    });

    rerender({ status: 'idle' as const });

    expect(onFlush).toHaveBeenCalledWith(expect.stringContaining('Should flush'), 'test');
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].content).toBe('Being edited');
  });

  it('multiple rapid idle transitions do not double-flush', () => {
    const { result, rerender } = renderHook(
      ({ status }) =>
        useMessageQueue({
          status,
          sessionBusy: false,
          sessionId: 'test',
          selectedCwd: '/dir',
          onFlush,
        }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    act(() => {
      result.current.addToQueue('Only once');
    });
    rerender({ status: 'idle' as const });
    rerender({ status: 'idle' as const });

    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});

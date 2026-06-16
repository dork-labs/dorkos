// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMessageQueue } from '../model/use-message-queue';
import type { ChatStatus } from '../model/chat-types';
import { useSessionStreamStore } from '@/layers/entities/session';

const defaultOptions = {
  status: 'idle' as const,
  sessionBusy: false,
  sessionId: 'test-session',
  selectedCwd: '/test/dir',
  onFlush: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // The queue now lives in the per-session stream store (DOR-81); reset it so
  // each test starts from an empty, isolated queue.
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

describe('useMessageQueue', () => {
  it('addToQueue appends item with unique id and content', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('First');
    });
    act(() => {
      result.current.addToQueue('Second');
    });

    expect(result.current.queue).toHaveLength(2);
    expect(result.current.queue[0].content).toBe('First');
    expect(result.current.queue[1].content).toBe('Second');
    expect(result.current.queue[0].id).toBeTruthy();
    expect(result.current.queue[1].id).toBeTruthy();
    expect(result.current.queue[0].id).not.toBe(result.current.queue[1].id);
  });

  it('addToQueue with empty string is rejected', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('');
    });
    act(() => {
      result.current.addToQueue('   ');
    });

    expect(result.current.queue).toHaveLength(0);
  });

  it('updateQueueItem modifies content at index, preserves id', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('Original');
    });
    const originalId = result.current.queue[0].id;

    act(() => {
      result.current.updateQueueItem(0, 'Updated');
    });

    expect(result.current.queue[0].content).toBe('Updated');
    expect(result.current.queue[0].id).toBe(originalId);
  });

  it('removeFromQueue removes item and adjusts editingIndex', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('A');
    });
    act(() => {
      result.current.addToQueue('B');
    });
    act(() => {
      result.current.addToQueue('C');
    });
    act(() => {
      result.current.startEditing(2);
    });

    act(() => {
      result.current.removeFromQueue(0);
    });

    expect(result.current.queue).toHaveLength(2);
    expect(result.current.editingIndex).toBe(1);
  });

  it('removeFromQueue when editing the removed item resets editingIndex to null', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('A');
    });
    act(() => {
      result.current.addToQueue('B');
    });
    act(() => {
      result.current.startEditing(0);
    });

    act(() => {
      result.current.removeFromQueue(0);
    });

    expect(result.current.editingIndex).toBeNull();
  });

  it('removeFromQueue when editing item after removed one decrements editingIndex', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('A');
    });
    act(() => {
      result.current.addToQueue('B');
    });
    act(() => {
      result.current.addToQueue('C');
    });
    act(() => {
      result.current.startEditing(2);
    });

    act(() => {
      result.current.removeFromQueue(1);
    });

    expect(result.current.editingIndex).toBe(1);
  });

  it('startEditing sets editingIndex and returns content', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('test content');
    });

    let returned = '';
    act(() => {
      returned = result.current.startEditing(0);
    });

    expect(returned).toBe('test content');
    expect(result.current.editingIndex).toBe(0);
  });

  it('cancelEditing resets editingIndex to null', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('test');
    });
    act(() => {
      result.current.startEditing(0);
    });

    act(() => {
      result.current.cancelEditing();
    });

    expect(result.current.editingIndex).toBeNull();
  });

  it('saveEditing updates item content and resets editingIndex', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('original');
    });
    act(() => {
      result.current.startEditing(0);
    });
    act(() => {
      result.current.saveEditing('updated');
    });

    expect(result.current.queue[0].content).toBe('updated');
    expect(result.current.editingIndex).toBeNull();
  });

  it('auto-flush fires on streaming to idle transition', () => {
    const onFlush = vi.fn();
    const { result, rerender } = renderHook(
      ({ status }) => useMessageQueue({ ...defaultOptions, status, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    act(() => {
      result.current.addToQueue('queued message');
    });

    rerender({ status: 'idle' as const });

    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('auto-flush sends PRISTINE content with the queued signal out-of-band', () => {
    const onFlush = vi.fn();
    const { result, rerender } = renderHook(
      ({ status }) => useMessageQueue({ ...defaultOptions, status, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    act(() => {
      result.current.addToQueue('My message');
    });
    rerender({ status: 'idle' as const });

    // No `[Note: …]` prose — content is byte-for-byte; queue origin rides `{ queued: true }`.
    expect(onFlush).toHaveBeenCalledWith('My message', 'test-session', { queued: true });
  });

  it('auto-flush skips when sessionBusy is true', () => {
    const onFlush = vi.fn();
    const { result, rerender } = renderHook(
      ({ status, sessionBusy }) =>
        useMessageQueue({ ...defaultOptions, status, sessionBusy, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus, sessionBusy: true } }
    );

    act(() => {
      result.current.addToQueue('queued');
    });
    rerender({ status: 'idle' as const, sessionBusy: true });

    expect(onFlush).not.toHaveBeenCalled();
  });

  it('auto-flush skips the item being edited and flushes second item', () => {
    const onFlush = vi.fn();
    const { result, rerender } = renderHook(
      ({ status }) => useMessageQueue({ ...defaultOptions, status, onFlush }),
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

    expect(onFlush).toHaveBeenCalledWith(expect.stringContaining('Should flush'), 'test-session', {
      queued: true,
    });
    expect(result.current.queue[0].content).toBe('Being edited');
  });

  it('auto-flush does nothing when queue is empty', () => {
    const onFlush = vi.fn();
    const { rerender } = renderHook(
      ({ status }) => useMessageQueue({ ...defaultOptions, status, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    rerender({ status: 'idle' as const });

    expect(onFlush).not.toHaveBeenCalled();
  });

  it('switching sessionId shows the new session queue and pins the old queue to its origin (DOR-81)', () => {
    // The queue is per-session in the store now, so switching from A to B shows
    // B's (empty) queue WITHOUT clearing A's — A's message stays pinned to A.
    const { result, rerender } = renderHook(
      ({ sessionId }) => useMessageQueue({ ...defaultOptions, sessionId }),
      { initialProps: { sessionId: 'session-a' } }
    );

    act(() => {
      result.current.addToQueue('msg');
    });
    expect(result.current.queue).toHaveLength(1);

    rerender({ sessionId: 'session-b' });

    // B's queue is empty…
    expect(result.current.queue).toHaveLength(0);
    // …but A's message was NOT discarded — it is pinned to A in the store.
    expect(useSessionStreamStore.getState().getSession('session-a').queuedMessages).toHaveLength(1);
  });

  it('switching selectedCwd shows an empty queue for the new context', () => {
    const { result, rerender } = renderHook(
      ({ sessionId, selectedCwd }) =>
        useMessageQueue({ ...defaultOptions, sessionId, selectedCwd }),
      { initialProps: { sessionId: 'session-a', selectedCwd: '/dir-a' } }
    );

    act(() => {
      result.current.addToQueue('msg');
    });
    expect(result.current.queue).toHaveLength(1);

    // A cwd change in practice accompanies a session change; the editing cursor
    // resets and the active session's queue is shown.
    rerender({ sessionId: 'session-b', selectedCwd: '/dir-b' });

    expect(result.current.queue).toHaveLength(0);
  });
});

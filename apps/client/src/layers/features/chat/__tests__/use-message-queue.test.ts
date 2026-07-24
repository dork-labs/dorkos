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

  it('saveEditing rewrites the edited item in place, preserving its id', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('Original');
    });
    const originalId = result.current.queue[0].id;

    act(() => {
      result.current.startEditing(originalId);
    });
    act(() => {
      result.current.saveEditing('Updated');
    });

    expect(result.current.queue[0].content).toBe('Updated');
    expect(result.current.queue[0].id).toBe(originalId);
    expect(result.current.editingId).toBeNull();
  });

  it('removeFromQueue removes the addressed item and reseats the derived editingIndex', () => {
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
    const [a, , c] = result.current.queue;
    act(() => {
      result.current.startEditing(c.id);
    });

    act(() => {
      result.current.removeFromQueue(a.id);
    });

    expect(result.current.queue).toHaveLength(2);
    // The cursor still points at C — its position just moved up.
    expect(result.current.editingId).toBe(c.id);
    expect(result.current.editingIndex).toBe(1);
  });

  it('removeFromQueue hits the intended item even when a flush dequeues the head first', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    for (const content of ['A', 'B', 'C', 'D']) {
      act(() => {
        result.current.addToQueue(content);
      });
    }
    const thirdId = result.current.queue[2].id;

    // The auto-flush dequeues the head between render and click. An index-based
    // remove would delete 'D' here; addressing by id cannot slip.
    act(() => {
      useSessionStreamStore
        .getState()
        .removeQueuedMessage('test-session', result.current.queue[0].id);
    });
    act(() => {
      result.current.removeFromQueue(thirdId);
    });

    expect(result.current.queue.map((item) => item.content)).toEqual(['B', 'D']);
  });

  it('removeFromQueue when editing the removed item clears the cursor', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('A');
    });
    act(() => {
      result.current.addToQueue('B');
    });
    const editedId = result.current.queue[0].id;
    act(() => {
      result.current.startEditing(editedId);
    });

    act(() => {
      result.current.removeFromQueue(editedId);
    });

    expect(result.current.editingId).toBeNull();
    expect(result.current.editingIndex).toBeNull();
  });

  it('startEditing sets the cursor and returns content', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('test content');
    });

    let returned: string | null = null;
    act(() => {
      returned = result.current.startEditing(result.current.queue[0].id);
    });

    expect(returned).toBe('test content');
    expect(result.current.editingIndex).toBe(0);
  });

  it('startEditing returns null for an item that is no longer queued', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    let returned: string | null = 'unset';
    act(() => {
      returned = result.current.startEditing('gone');
    });

    expect(returned).toBeNull();
    expect(result.current.editingId).toBeNull();
  });

  it('cancelEditing clears the cursor', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('test');
    });
    act(() => {
      result.current.startEditing(result.current.queue[0].id);
    });

    act(() => {
      result.current.cancelEditing();
    });

    expect(result.current.editingIndex).toBeNull();
  });

  it('saveEditing updates item content and clears the cursor', () => {
    const { result } = renderHook(() => useMessageQueue(defaultOptions));

    act(() => {
      result.current.addToQueue('original');
    });
    act(() => {
      result.current.startEditing(result.current.queue[0].id);
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

  it('auto-flush skips while sessionBusy is true', () => {
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
      result.current.startEditing(result.current.queue[0].id);
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

describe('useMessageQueue — a queued message never strands', () => {
  type FlushCallback = (
    content: string,
    originSessionId: string,
    opts: { queued: boolean }
  ) => void;

  /** Queues one message mid-stream and parks the editing cursor on it. */
  function editOnlyItemThenSettle(onFlush: FlushCallback) {
    const harness = renderHook(
      ({ status }) => useMessageQueue({ ...defaultOptions, status, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    act(() => {
      harness.result.current.addToQueue('only item');
    });
    act(() => {
      harness.result.current.startEditing(harness.result.current.queue[0].id);
    });

    // The turn ends while the only queued item is under edit: nothing is
    // flushable yet, so the flush is owed rather than dropped.
    harness.rerender({ status: 'idle' as const });
    expect(onFlush).not.toHaveBeenCalled();

    return harness;
  }

  it('flushes the owed message when the edit is saved', () => {
    const onFlush = vi.fn();
    const { result } = editOnlyItemThenSettle(onFlush);

    act(() => {
      result.current.saveEditing('edited item');
    });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('edited item', 'test-session', { queued: true });
    expect(result.current.queue).toHaveLength(0);
    expect(result.current.editingIndex).toBeNull();
  });

  it('flushes the owed message when the edit is cancelled', () => {
    const onFlush = vi.fn();
    const { result } = editOnlyItemThenSettle(onFlush);

    act(() => {
      result.current.cancelEditing();
    });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('only item', 'test-session', { queued: true });
    expect(result.current.queue).toHaveLength(0);
  });

  it('flushes the owed message exactly once, however many idle renders follow', () => {
    const onFlush = vi.fn();
    const { result, rerender } = editOnlyItemThenSettle(onFlush);

    act(() => {
      result.current.cancelEditing();
    });
    rerender({ status: 'idle' as const });
    rerender({ status: 'idle' as const });

    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('flushes only the head when the edit ends with more items behind it', () => {
    const onFlush = vi.fn();
    const { result, rerender } = renderHook(
      ({ status }) => useMessageQueue({ ...defaultOptions, status, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    act(() => {
      result.current.addToQueue('first');
    });
    act(() => {
      result.current.addToQueue('second');
    });
    act(() => {
      result.current.startEditing(result.current.queue[0].id);
    });

    // 'second' is flushable at the edge, so the owed flush is satisfied there…
    rerender({ status: 'idle' as const });
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('second', 'test-session', { queued: true });

    // …and ending the edit does not fire a second, un-owed flush: 'first' waits
    // for the turn that 'second' just started.
    act(() => {
      result.current.cancelEditing();
    });
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(result.current.queue.map((item) => item.content)).toEqual(['first']);
  });

  it('flushes the owed message once the session stops being busy', () => {
    const onFlush = vi.fn();
    const { result, rerender } = renderHook(
      ({ status, sessionBusy }) =>
        useMessageQueue({ ...defaultOptions, status, sessionBusy, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus, sessionBusy: true } }
    );

    act(() => {
      result.current.addToQueue('waiting on the lock');
    });
    rerender({ status: 'idle' as const, sessionBusy: true });
    expect(onFlush).not.toHaveBeenCalled();

    rerender({ status: 'idle' as const, sessionBusy: false });

    expect(onFlush).toHaveBeenCalledWith('waiting on the lock', 'test-session', { queued: true });
  });

  it("drops an owed flush on a session switch — A's message waits for A's own next turn (DOR-81)", () => {
    const onFlush = vi.fn();
    const { result, rerender } = renderHook(
      ({ status, sessionId }) => useMessageQueue({ ...defaultOptions, status, sessionId, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus, sessionId: 'session-a' } }
    );

    act(() => {
      result.current.addToQueue('for A');
    });
    act(() => {
      result.current.startEditing(result.current.queue[0].id);
    });

    // A settles while its only item is under edit — a flush is owed to A.
    rerender({ status: 'idle' as const, sessionId: 'session-a' });
    expect(onFlush).not.toHaveBeenCalled();

    // Switch to B. The owed flush belongs to A and is dropped with the tracker,
    // so nothing A composed can be delivered from inside B.
    rerender({ status: 'idle' as const, sessionId: 'session-b' });
    act(() => {
      result.current.cancelEditing();
    });

    expect(onFlush).not.toHaveBeenCalled();
    expect(useSessionStreamStore.getState().getSession('session-a').queuedMessages).toHaveLength(1);
    expect(useSessionStreamStore.getState().getSession('session-b').queuedMessages).toHaveLength(0);

    // Back in A the message is still deliverable — to A, on A's own edge.
    rerender({ status: 'streaming' as const, sessionId: 'session-a' });
    rerender({ status: 'idle' as const, sessionId: 'session-a' });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('for A', 'session-a', { queued: true });
  });
});

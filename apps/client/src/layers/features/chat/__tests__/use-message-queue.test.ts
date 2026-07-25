// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SessionEvent, SessionStatus } from '@dorkos/shared/session-stream';
import { useMessageQueue } from '../model/use-message-queue';
import type { QueueFlushOptions } from '../model/use-message-queue';
import type { ChatStatus } from '../model/chat-types';
import { useSessionStreamStore } from '@/layers/entities/session';

const defaultOptions = {
  status: 'idle' as const,
  sessionBusy: false,
  sessionId: 'test-session',
  selectedCwd: '/test/dir',
  onFlush: vi.fn(),
};

/**
 * The out-of-band flush options every queue flush carries. `restore` is the
 * queue's undo — the submit path calls it when a trigger is refused, so a
 * flush that never lands puts the message back instead of destroying it.
 */
const FLUSH_OPTS = { queued: true, restore: expect.any(Function) };

/** The flush callback's real shape, so a spy passed to a helper still typechecks. */
type FlushCallback = (content: string, originSessionId: string, opts: QueueFlushOptions) => void;

/** A minimal projected status, so the queue can read an authoritative lifecycle. */
function statusWith(lifecycle: SessionStatus['lifecycle']): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle,
    lastError: null,
  };
}

/** An approval landing mid-turn — what puts a real session into `blocked`. */
function approvalEvent(seq: number, id: string): SessionEvent {
  return {
    type: 'approval_required',
    seq,
    startedAt: 1000,
    remainingMs: 30000,
    id,
    toolName: 'Bash',
    input: 'rm -rf build',
    hasSuggestions: false,
  };
}

/** The exact server sequence for "the agent stopped to ask you something". */
function blockSession(sessionId: string, seq: number) {
  const store = useSessionStreamStore.getState();
  store.applyEvent(sessionId, { seq, type: 'status_change', status: statusWith('streaming') });
  store.applyEvent(sessionId, approvalEvent(seq + 1, 'approval-1'));
  // The turn ends while the approval is outstanding: the server projects
  // `blocked` and — critically — KEEPS the turn's session lock.
  store.applyEvent(sessionId, { seq: seq + 2, type: 'turn_end' });
}

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
    expect(onFlush).toHaveBeenCalledWith('My message', 'test-session', FLUSH_OPTS);
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

    // Exact, not `stringContaining`: a truncated or annotated flush is a
    // different message than the one the person typed, and the loose matcher
    // would have passed for both.
    expect(onFlush).toHaveBeenCalledWith('Should flush', 'test-session', FLUSH_OPTS);
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
    expect(onFlush).toHaveBeenCalledWith('edited item', 'test-session', FLUSH_OPTS);
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
    expect(onFlush).toHaveBeenCalledWith('only item', 'test-session', FLUSH_OPTS);
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
    expect(onFlush).toHaveBeenCalledWith('second', 'test-session', FLUSH_OPTS);

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

    expect(onFlush).toHaveBeenCalledWith('waiting on the lock', 'test-session', FLUSH_OPTS);
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
    expect(onFlush).toHaveBeenCalledWith('for A', 'session-a', FLUSH_OPTS);
  });
});

describe('useMessageQueue — the agent asks for permission mid-queue (DOR-480)', () => {
  /**
   * The exact sequence that destroyed a message: the agent is streaming, a
   * follow-up is queued, then a tool needs approval. The server projects
   * `blocked` but keeps the turn's session lock, and the renderer collapses
   * `blocked` → `idle` on purpose — so the drain saw a drainable session,
   * dequeued the message, and handed it to a trigger the lock refused.
   *
   * The measurement is the QUEUE'S CONTENTS, not whether a mock fired: a test
   * that only asserted `onFlush` was not called would still pass if the item had
   * been dequeued and dropped.
   */
  function queueThenBlock(onFlush: FlushCallback) {
    const harness = renderHook(
      ({ status }) => useMessageQueue({ ...defaultOptions, status, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    act(() => {
      harness.result.current.addToQueue('and then deploy it');
    });
    act(() => {
      blockSession('test-session', 1);
    });

    // What the composer sees: `blocked` renders as `idle` (CLI-B7 / the
    // rendered-status contract), so the drain is asked to run.
    harness.rerender({ status: 'idle' as const });
    return harness;
  }

  it('does not drain into a session that is waiting on an approval', () => {
    const onFlush = vi.fn();
    const { result } = queueThenBlock(onFlush);

    expect(onFlush).not.toHaveBeenCalled();
    // The message is still there — the whole point. Before the fix the store
    // held zero queued messages here and nothing re-enqueued them.
    expect(result.current.queue.map((item) => item.content)).toEqual(['and then deploy it']);
    expect(useSessionStreamStore.getState().getSession('test-session').queuedMessages).toHaveLength(
      1
    );
  });

  it('says why a hand-send is unavailable while an approval is outstanding', () => {
    const onFlush = vi.fn();
    const { result } = queueThenBlock(onFlush);

    expect(result.current.sendBlockedReason).toBe('Waiting for your answer above');

    act(() => {
      result.current.sendNow(result.current.queue[0].id);
    });
    expect(onFlush).not.toHaveBeenCalled();
    expect(result.current.queue).toHaveLength(1);
  });

  it('delivers the still-owed message once the approval is answered', () => {
    const onFlush = vi.fn();
    const { result, rerender } = queueThenBlock(onFlush);

    // Approved: the interaction resolves, the turn resumes, then settles.
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applyEvent('test-session', { seq: 10, type: 'interaction_resolved', id: 'approval-1' });
      store.applyEvent('test-session', {
        seq: 11,
        type: 'status_change',
        status: statusWith('streaming'),
      });
    });
    rerender({ status: 'streaming' as const });
    act(() => {
      useSessionStreamStore.getState().applyEvent('test-session', { seq: 12, type: 'turn_end' });
    });
    rerender({ status: 'idle' as const });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('and then deploy it', 'test-session', FLUSH_OPTS);
    expect(result.current.queue).toHaveLength(0);
  });

  it('restores a flushed message to its original position when the trigger is refused', () => {
    // What the submit path does on a 409: call the flush's `restore`. Position
    // matters — a queue is an order the person chose.
    const flushes: { content: string; restore: () => void }[] = [];
    const onFlush = vi.fn((content: string, _origin: string, opts: { restore: () => void }) => {
      flushes.push({ content, restore: opts.restore });
    });
    const { result, rerender } = renderHook(
      ({ status }) => useMessageQueue({ ...defaultOptions, status, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    for (const content of ['first', 'second', 'third']) {
      act(() => {
        result.current.addToQueue(content);
      });
    }
    rerender({ status: 'idle' as const });

    expect(flushes.map((f) => f.content)).toEqual(['first']);
    expect(result.current.queue.map((item) => item.content)).toEqual(['second', 'third']);

    act(() => {
      flushes[0].restore();
    });

    expect(result.current.queue.map((item) => item.content)).toEqual(['first', 'second', 'third']);

    // Idempotent: a second restore cannot duplicate the message.
    act(() => {
      flushes[0].restore();
    });
    expect(result.current.queue.map((item) => item.content)).toEqual(['first', 'second', 'third']);
  });
});

describe('useMessageQueue — a failed turn does not trap the queue (DOR-480)', () => {
  /** Queues two messages, then the turn fails. */
  function queueThenFail(onFlush: FlushCallback) {
    const harness = renderHook(
      ({ status }) => useMessageQueue({ ...defaultOptions, status, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );
    act(() => {
      harness.result.current.addToQueue('first');
    });
    act(() => {
      harness.result.current.addToQueue('second');
    });
    harness.rerender({ status: 'error' as const });
    return harness;
  }

  it('holds the queue rather than auto-firing into a session that just failed', () => {
    const onFlush = vi.fn();
    const { result } = queueThenFail(onFlush);

    // Deliberate: the pump arms on streaming→idle only, so a failed turn waits
    // for the person to decide. What must NOT happen is losing the messages.
    expect(onFlush).not.toHaveBeenCalled();
    expect(result.current.queue.map((item) => item.content)).toEqual(['first', 'second']);
  });

  it('lets the operator send a stranded message by hand, in any order', () => {
    const onFlush = vi.fn();
    const { result } = queueThenFail(onFlush);

    // `error` is not a reason a send cannot happen — the server released the
    // turn's lock when the turn died.
    expect(result.current.sendBlockedReason).toBeNull();

    const secondId = result.current.queue[1].id;
    act(() => {
      result.current.sendNow(secondId);
    });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('second', 'test-session', FLUSH_OPTS);
    // Only the chosen message left; the other is untouched and still queued.
    expect(result.current.queue.map((item) => item.content)).toEqual(['first']);
  });

  it('refuses a hand-send while a reply is streaming, and keeps the message', () => {
    const onFlush = vi.fn();
    const { result } = renderHook(() =>
      useMessageQueue({ ...defaultOptions, status: 'streaming', onFlush })
    );
    act(() => {
      result.current.addToQueue('later');
    });

    expect(result.current.sendBlockedReason).toBe('Waiting for the reply to finish');
    act(() => {
      result.current.sendNow(result.current.queue[0].id);
    });

    expect(onFlush).not.toHaveBeenCalled();
    expect(result.current.queue).toHaveLength(1);
  });

  it('refuses a hand-send while the session is busy, and keeps the message', () => {
    const onFlush = vi.fn();
    const { result } = renderHook(() =>
      useMessageQueue({ ...defaultOptions, sessionBusy: true, onFlush })
    );
    act(() => {
      result.current.addToQueue('later');
    });

    expect(result.current.sendBlockedReason).toBe('This session is busy right now');
    act(() => {
      result.current.sendNow(result.current.queue[0].id);
    });

    expect(onFlush).not.toHaveBeenCalled();
    expect(result.current.queue).toHaveLength(1);
  });

  it('a hand-send does not also drain a second message behind it', () => {
    const onFlush = vi.fn();
    const { result } = queueThenFail(onFlush);

    act(() => {
      result.current.sendNow(result.current.queue[0].id);
    });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(result.current.queue.map((item) => item.content)).toEqual(['second']);
  });
});

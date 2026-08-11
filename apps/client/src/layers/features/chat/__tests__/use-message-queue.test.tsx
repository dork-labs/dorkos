// @vitest-environment jsdom
/**
 * `useMessageQueue` — the composer's view of the SERVER's queue (spec
 * `persistent-session-runtime`, task 2.6).
 *
 * Everything the old local FIFO was tested for — auto-flush on the
 * streaming→idle edge, the owed-flush bookkeeping, origin pinning, the requeue
 * undo — is gone with the FIFO itself; the server dispatches, so there is no
 * flush to arm and nothing to put back. What survives is the part that was
 * never about storage: the editing cursor keyed by a stable id, and the promise
 * that nothing typed is lost.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useMessageQueue } from '../model/use-message-queue';
import { useFakeServerQueue, queued, notFound } from './fake-server-queue';
import { useSessionStreamStore } from '@/layers/entities/session';
import { TransportProvider } from '@/layers/shared/model';
import type { Transport } from '@dorkos/shared/transport';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

const SESSION_ID = 'test-session';

/**
 * The transport the provider hands down. Assigned by {@link mountQueue} before
 * the consumer renders, because a provider cannot read a value out of the tree
 * it wraps.
 */
let sharedTransport: Transport | null = null;

/**
 * Mount the hook with a fake server whose transport is already in the provider.
 *
 * Two passes: the first builds the fake (and its transport) outside the
 * provider, the second renders the hook underneath it.
 */
function mountQueue(clientId = 'window-a') {
  const probe = renderHook(() => useFakeServerQueue(clientId));
  sharedTransport = probe.result.current.transport;
  const view = renderHook(
    () => {
      const server = probe.result.current;
      return useMessageQueue({
        sessionId: SESSION_ID,
        waiting: server.waiting,
        onEnqueue: server.enqueue,
      });
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <TransportProvider transport={sharedTransport!}>{children}</TransportProvider>
      ),
    }
  );
  /** Re-render the consumer after the fake server changed underneath it. */
  const sync = () => {
    probe.rerender();
    view.rerender();
  };
  return { server: probe.result, view, sync };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

describe('useMessageQueue — the chips', () => {
  it('draws a chip per waiting message, in the order the server holds it', () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'first'), queued('q2', 'second')));
    sync();

    expect(view.result.current.queue.map((item) => item.content)).toEqual(['first', 'second']);
    expect(view.result.current.queue.map((item) => item.id)).toEqual(['q1', 'q2']);
  });

  it('marks a chip another window queued, and leaves it editable', async () => {
    const { server, view, sync } = mountQueue('window-a');
    act(() => server.current.seed(queued('q1', 'mine'), queued('q2', 'theirs', 'window-b')));
    sync();

    expect(view.result.current.queue.map((item) => item.mine)).toEqual([true, false]);

    // "Not mine" is a label, never a lock: the queue belongs to the session.
    act(() => view.result.current.updateQueued('q2', 'theirs, reworded'));
    await waitFor(() => {
      expect(server.current.waiting.map((m) => m.content)).toEqual(['mine', 'theirs, reworded']);
    });
  });

  it('says nothing about a message that got exactly what it asked for', () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'plain')));
    sync();
    expect(view.result.current.queue[0]!.notice).toBeNull();
  });

  it('carries a downgrade notice onto the chip it belongs to', () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'change course')));
    act(() =>
      server.current.announceOutcome({
        messageId: 'q1',
        requested: 'steer',
        applied: 'queue',
        degradedBecause: 'unsupported',
      })
    );
    sync();

    expect(view.result.current.queue[0]!.notice).toBe(
      'Queued — this agent cannot take a message mid-task'
    );
  });

  it('stays quiet when the only thing that happened is that it ran immediately', () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'ran now')));
    act(() =>
      server.current.announceOutcome({
        messageId: 'q1',
        requested: 'steer',
        applied: 'queue',
        degradedBecause: 'session-idle',
      })
    );
    sync();

    expect(view.result.current.queue[0]!.notice).toBeNull();
  });
});

describe('useMessageQueue — putting a message on the queue', () => {
  it('hands the words to the server and reports that it took them', async () => {
    const { server, view, sync } = mountQueue();
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await view.result.current.addToQueue('  follow-up  ');
    });
    sync();

    expect(accepted).toBe(true);
    expect(server.current.enqueued).toEqual(['follow-up']);
    expect(view.result.current.queue.map((item) => item.content)).toEqual(['follow-up']);
  });

  it('refuses an empty message without troubling the server', async () => {
    const { server, view } = mountQueue();
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await view.result.current.addToQueue('   ');
    });
    expect(accepted).toBe(false);
    expect(server.current.enqueued).toEqual([]);
  });

  it('reports a refused enqueue as refused, so the composer can keep the words', async () => {
    const { server, view } = mountQueue();
    act(() => server.current.failNextEnqueue());
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await view.result.current.addToQueue('do not lose me');
    });
    expect(accepted).toBe(false);
  });
});

describe('useMessageQueue — the editing cursor', () => {
  it('startEditing sets the cursor and returns the content', () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'first'), queued('q2', 'second')));
    sync();

    let content: string | null = null;
    act(() => {
      content = view.result.current.startEditing('q2');
    });
    expect(content).toBe('second');
    expect(view.result.current.editingId).toBe('q2');
    expect(view.result.current.editingIndex).toBe(1);
  });

  it('returns null for an item that is no longer queued', () => {
    const { view } = mountQueue();
    let content: string | null = 'unset';
    act(() => {
      content = view.result.current.startEditing('gone');
    });
    expect(content).toBeNull();
    expect(view.result.current.editingId).toBeNull();
  });

  it('keeps the cursor on its message when the head dispatches under it', () => {
    // The positional-cursor bug this exists to prevent: the head leaves while
    // the panel is on screen, and an index captured at render time silently
    // starts addressing the neighbour.
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'first'), queued('q2', 'second')));
    sync();
    act(() => void view.result.current.startEditing('q2'));

    act(() => server.current.dispatchHead());
    sync();

    expect(view.result.current.editingId).toBe('q2');
    expect(view.result.current.editingIndex).toBe(0);
  });

  it('saveEditing rewrites the message on the server and clears the cursor', async () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'first')));
    sync();
    act(() => void view.result.current.startEditing('q1'));

    act(() => view.result.current.saveEditing('first, rewritten'));

    await waitFor(() => {
      expect(server.current.waiting[0]!.content).toBe('first, rewritten');
    });
    expect(view.result.current.editingId).toBeNull();
  });

  it('cancelEditing clears the cursor and writes nothing', () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'first')));
    sync();
    act(() => void view.result.current.startEditing('q1'));
    act(() => view.result.current.cancelEditing());
    expect(view.result.current.editingId).toBeNull();
    expect(server.current.waiting[0]!.content).toBe('first');
  });
});

describe('useMessageQueue — removing', () => {
  it('takes the message off the server queue', async () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'first'), queued('q2', 'second')));
    sync();

    act(() => view.result.current.removeFromQueue('q1'));

    await waitFor(() => expect(server.current.waiting.map((m) => m.id)).toEqual(['q2']));
  });

  it('clears the cursor when the removed message was the one under edit', () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'first')));
    sync();
    act(() => void view.result.current.startEditing('q1'));
    act(() => view.result.current.removeFromQueue('q1'));
    expect(view.result.current.editingId).toBeNull();
  });

  it('says nothing when the message had already left the queue', async () => {
    const { view } = mountQueue();
    act(() => view.result.current.removeFromQueue('never-here'));
    await waitFor(() => expect(toast.error).not.toHaveBeenCalled());
  });

  it('says so when the request itself failed', async () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'first')));
    sync();
    vi.mocked(server.current.transport.removeQueuedMessage).mockRejectedValueOnce(
      new Error('Failed to fetch')
    );

    act(() => view.result.current.removeFromQueue('q1'));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not take that message off the queue')
    );
  });
});

describe('useMessageQueue — send next and reorder', () => {
  it('moves a message to the front of the line', async () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'first'), queued('q2', 'second')));
    sync();

    let moved: boolean | undefined;
    act(() => {
      moved = view.result.current.sendNow('q2');
    });

    expect(moved).toBe(true);
    await waitFor(() => expect(server.current.waiting.map((m) => m.id)).toEqual(['q2', 'q1']));
  });

  it('refuses a send-next on the message that is already next', () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'first')));
    sync();

    let moved: boolean | undefined;
    act(() => {
      moved = view.result.current.sendNow('q1');
    });

    expect(moved).toBe(false);
    expect(server.current.transport.updateQueuedMessage).not.toHaveBeenCalled();
  });

  it('moves a message one place earlier, so any order is reachable', async () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'a'), queued('q2', 'b'), queued('q3', 'c')));
    sync();

    act(() => view.result.current.moveUp('q3'));

    await waitFor(() =>
      expect(server.current.waiting.map((m) => m.id)).toEqual(['q1', 'q3', 'q2'])
    );
  });

  it('retries against the new front when the head launched mid-click', async () => {
    // The launching-head race: the message the move named starts running between
    // the render that drew the row and the click that moved it, so the server
    // answers the move with "not found". One retry against whatever is now at
    // the front turns that into the move the person asked for.
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'launching'), queued('q2', 'b'), queued('q3', 'c')));
    sync();

    const patch = vi.mocked(server.current.transport.updateQueuedMessage);
    patch.mockImplementationOnce(async () => {
      // The head leaves — exactly what a `turn_start` does to the queue.
      server.current.dispatchHead();
      throw notFound();
    });

    act(() => view.result.current.moveUp('q3'));

    await waitFor(() => expect(server.current.waiting.map((m) => m.id)).toEqual(['q3', 'q2']));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('gives up quietly when the message itself has left the queue', async () => {
    const { server, view, sync } = mountQueue();
    act(() => server.current.seed(queued('q1', 'a'), queued('q2', 'b')));
    sync();

    const patch = vi.mocked(server.current.transport.updateQueuedMessage);
    patch.mockImplementation(async () => {
      throw notFound();
    });

    act(() => view.result.current.sendNow('q2'));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(toast.error).not.toHaveBeenCalled();
  });
});

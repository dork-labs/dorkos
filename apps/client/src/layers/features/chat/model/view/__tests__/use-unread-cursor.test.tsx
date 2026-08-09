// @vitest-environment jsdom
/**
 * Where a reader left off in a session, held on the server (team-room-home §D4).
 *
 * The rules under test are the ones a person would notice breaking: the rule
 * does not move while you are looking at it, it does move when you read the same
 * conversation somewhere else, and nothing about read state is written to this
 * browser any more.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ReadCursor } from '@dorkos/shared/read-cursor-schemas';
import { createMockTransport } from '@dorkos/test-utils';

/** Handlers the hook registered, keyed by the event they wait for. */
const handlers = new Map<string, (payload?: unknown) => void>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (event: string, handler: (payload?: unknown) => void) => {
      handlers.set(event, handler);
    },
  };
});

import { unreadPlacement } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { useUnreadCursor } from '../use-unread-cursor';

/** A stored cursor as the route answers it. */
function cursor(threadId: string, lastReadSeq: number, userId = 'author-me'): ReadCursor {
  return {
    userId,
    threadKind: 'session',
    threadId,
    lastReadSeq,
    updatedAt: new Date().toISOString(),
  };
}

/** A message as the hook counts it. */
interface TestMessage {
  id: string;
  _streaming?: boolean;
}

/** A transcript of `count` server-confirmed messages, ids `m1`…`mN`. */
function transcript(count: number): TestMessage[] {
  return Array.from({ length: count }, (_, i) => ({ id: `m${i + 1}` }));
}

/** Render the hook against a transport, returning both so a test can drive either. */
function setup(
  overrides: Partial<Transport>,
  {
    sessionId = 's-1',
    messages = transcript(3),
  }: { sessionId?: string; messages?: TestMessage[] } = {}
) {
  const transport = createMockTransport(overrides);
  const view = renderHook(
    ({ id, msgs }: { id: string; msgs: TestMessage[] }) => useUnreadCursor(id, msgs),
    {
      initialProps: { id: sessionId, msgs: messages },
      wrapper: ({ children }: { children: ReactNode }) => (
        <TransportProvider transport={transport}>{children}</TransportProvider>
      ),
    }
  );
  return { transport, ...view };
}

/** Fire the `read_cursor` broadcast the hook subscribed to. */
function broadcast(payload: unknown): void {
  act(() => handlers.get('read_cursor')?.(payload));
}

beforeEach(() => {
  handlers.clear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useUnreadCursor', () => {
  it('places the rule after the message the stored position counts to', async () => {
    const { result } = setup({
      getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 2)),
    });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    // "Two messages seen" means the rule goes after the second one — the same
    // arithmetic a room's cursor does against its entry seqs.
    expect(result.current.lastSeenMessageId).toBe('m2');
  });

  it('draws no rule for a session nobody has read', async () => {
    const { result } = setup({ getReadCursor: vi.fn().mockResolvedValue(null) });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.lastSeenMessageId).toBeNull();
  });

  it('draws no rule when the position counts the whole transcript', async () => {
    const { result } = setup({ getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 3)) });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.lastSeenMessageId).toBeNull();
    expect(result.current.unreadFromStart).toBe(false);
  });

  it('draws the rule above everything for a reader who has read nothing', async () => {
    // A stored zero is a real position, not an absent cursor: this reader has
    // been here and read none of it, so the rule belongs above the first
    // message — the same answer a room gives a member who has read nothing.
    const { result } = setup({ getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 0)) });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.unreadFromStart).toBe(true);
    expect(result.current.lastSeenMessageId).toBeNull();
  });

  it('clamps a position that runs past a trimmed transcript, drawing no rule', async () => {
    // The transcript came back shorter than the cursor — trimmed, or compacted
    // below it. What is missing had been read, so this is "caught up", NOT
    // "everything on screen is new".
    const { result } = setup({ getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 9)) });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.lastSeenMessageId).toBeNull();
    expect(result.current.unreadFromStart).toBe(false);
  });

  it('does not wedge after clamping: the next mark still records the real end', async () => {
    // The clamp is render-side only. A cursor of 9 over a 3-message transcript
    // still has to let a 4th message be recorded when it lands, or the session
    // would never be markable again.
    const setReadCursor = vi.fn().mockResolvedValue(cursor('s-1', 4));
    const { result, rerender } = setup({
      getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 9)),
      setReadCursor,
    });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    rerender({ id: 's-1', msgs: transcript(10) });
    act(() => result.current.markSeen());

    await waitFor(() => expect(setReadCursor).toHaveBeenCalledWith('session', 's-1', 10));
  });

  it('counts only the messages the server has confirmed', async () => {
    // The optimistic user bubble and the in-progress assistant one are rendered
    // but not stored anywhere; counting them would record a position for
    // messages that do not exist, and the reconcile that replaces them would
    // leave the cursor ahead of the transcript, marking unread messages read.
    const setReadCursor = vi.fn().mockResolvedValue(cursor('s-1', 2));
    const { result } = setup(
      { getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 1)), setReadCursor },
      {
        messages: [
          ...transcript(2),
          { id: 'optimistic-user', _streaming: true },
          { id: 'in-progress-assistant', _streaming: true },
        ],
      }
    );

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    act(() => result.current.markSeen());

    await waitFor(() => expect(setReadCursor).toHaveBeenCalledWith('session', 's-1', 2));
  });

  it('places the rule identically to a room, given the same shaped input', async () => {
    // The acceptance criterion, stated as an equality rather than as prose: the
    // hook's placement IS `unreadPlacement` over the transcript's positions, so
    // a room cursor and a session cursor at the same position draw the same line.
    for (const stored of [0, 1, 2, 3, 9]) {
      const { result, unmount } = setup({
        getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', stored)),
      });
      await waitFor(() => expect(result.current.isHydrated).toBe(true));

      const asRoomEntries = transcript(3).map((message, index) => ({
        id: message.id,
        seq: index + 1,
      }));
      const room = unreadPlacement(asRoomEntries, Math.min(stored, asRoomEntries.length));

      expect({
        lastSeenId: result.current.lastSeenMessageId,
        fromStart: result.current.unreadFromStart,
      }).toEqual(room);
      unmount();
    }
  });

  it('settles hydrated even when the read fails, so the list is never left waiting', async () => {
    const { result } = setup({
      getReadCursor: vi.fn().mockRejectedValue(new Error('no server')),
    });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.lastSeenMessageId).toBeNull();
  });

  it('records the whole transcript through the API, and writes nothing to this browser', async () => {
    const setReadCursor = vi.fn().mockResolvedValue(cursor('s-1', 3));
    const { result } = setup({
      getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 1)),
      setReadCursor,
    });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    act(() => result.current.markSeen());

    await waitFor(() => expect(setReadCursor).toHaveBeenCalledWith('session', 's-1', 3));
    // The watermark is gone, not merely unused: nothing about read state may be
    // left in this browser to disagree with the server later.
    expect(window.localStorage.length).toBe(0);
  });

  it('holds the rule where it was while the reader marks the session seen', async () => {
    const { result } = setup({
      getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 1)),
      setReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 3)),
    });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    act(() => result.current.markSeen());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    expect(
      result.current.lastSeenMessageId,
      'a rule that vanishes the moment you arrive is a rule you never read'
    ).toBe('m1');
  });

  it('does not record anything before it knows what is already recorded', () => {
    // Hydration is a round trip; a mark taken before it lands would race the
    // answer and could only ever move the cursor forward past unread messages.
    let resolve: (value: ReadCursor | null) => void = () => {};
    const setReadCursor = vi.fn().mockResolvedValue(cursor('s-1', 3));
    const { result } = setup({
      getReadCursor: vi.fn().mockReturnValue(
        new Promise<ReadCursor | null>((r) => {
          resolve = r;
        })
      ),
      setReadCursor,
    });

    act(() => result.current.markSeen());

    expect(result.current.isHydrated).toBe(false);
    expect(setReadCursor).not.toHaveBeenCalled();
    act(() => resolve(null));
  });

  it('writes once for a burst, coalescing behind the request in flight', async () => {
    let release: (value: ReadCursor) => void = () => {};
    const setReadCursor = vi.fn().mockImplementation(
      () =>
        new Promise<ReadCursor>((r) => {
          release = r;
        })
    );
    const { result, rerender } = setup(
      {
        getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 1)),
        setReadCursor,
      },
      { messages: transcript(2) }
    );

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    act(() => result.current.markSeen());
    expect(setReadCursor).toHaveBeenCalledTimes(1);

    // Two more messages land while that first write is still in flight. Only
    // where the transcript ENDS UP is worth a request.
    rerender({ id: 's-1', msgs: transcript(3) });
    act(() => result.current.markSeen());
    rerender({ id: 's-1', msgs: transcript(4) });
    act(() => result.current.markSeen());
    expect(setReadCursor).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(cursor('s-1', 2));
    });

    expect(setReadCursor).toHaveBeenCalledTimes(2);
    expect(setReadCursor).toHaveBeenLastCalledWith('session', 's-1', 4);
  });

  it('stops asking after a refused write instead of retrying every message', async () => {
    const setReadCursor = vi.fn().mockRejectedValue(new Error('Read state needs a DorkOS server'));
    const { result, rerender } = setup(
      { getReadCursor: vi.fn().mockResolvedValue(null), setReadCursor },
      { messages: transcript(1) }
    );

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    act(() => result.current.markSeen());
    await waitFor(() => expect(setReadCursor).toHaveBeenCalledTimes(1));

    rerender({ id: 's-1', msgs: transcript(2) });
    act(() => result.current.markSeen());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    expect(setReadCursor).toHaveBeenCalledTimes(1);
  });

  it('clears the rule when the same person reads the session on another device', async () => {
    const getReadCursor = vi.fn().mockResolvedValue(cursor('s-1', 1));
    const { result } = setup({ getReadCursor });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.lastSeenMessageId).toBe('m1');

    broadcast({ userId: 'author-me', threadKind: 'session', threadId: 's-1', lastReadSeq: 3 });

    // The event carried the position, so the rule goes out on it — no second read.
    expect(result.current.lastSeenMessageId).toBeNull();
    expect(result.current.unreadFromStart).toBe(false);
    expect(getReadCursor).toHaveBeenCalledTimes(1);
  });

  it('ignores its own write echoing back off the broadcast', async () => {
    const { result } = setup({
      getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 1)),
      setReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 3)),
    });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    act(() => result.current.markSeen());

    // Every write broadcasts, including this tab's own — and it may arrive
    // before its own HTTP response does. Applying it would clear the rule under
    // the reader who is still looking at it.
    broadcast({ userId: 'author-me', threadKind: 'session', threadId: 's-1', lastReadSeq: 3 });

    expect(result.current.lastSeenMessageId).toBe('m1');
  });

  it('ignores a cursor moved in another thread', async () => {
    const { result } = setup({ getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 1)) });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    broadcast({ userId: 'author-me', threadKind: 'session', threadId: 's-2', lastReadSeq: 3 });
    broadcast({ userId: 'author-me', threadKind: 'room', threadId: 's-1', lastReadSeq: 3 });
    broadcast({ threadKind: 'session', threadId: 's-1' });

    expect(result.current.lastSeenMessageId).toBe('m1');
  });

  it('ignores a cursor belonging to somebody else once it knows who the reader is', async () => {
    const { result } = setup({
      getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 1, 'author-me')),
    });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    broadcast({
      userId: 'author-someone-else',
      threadKind: 'session',
      threadId: 's-1',
      lastReadSeq: 3,
    });

    expect(result.current.lastSeenMessageId).toBe('m1');
  });

  it('re-reads the cursor when the view switches session', async () => {
    const getReadCursor = vi
      .fn()
      .mockResolvedValueOnce(cursor('s-1', 1))
      .mockResolvedValueOnce(cursor('s-2', 2));
    const { result, rerender } = setup({ getReadCursor });

    await waitFor(() => expect(result.current.lastSeenMessageId).toBe('m1'));

    rerender({ id: 's-2', msgs: transcript(3) });

    await waitFor(() => expect(result.current.lastSeenMessageId).toBe('m2'));
    expect(getReadCursor).toHaveBeenNthCalledWith(2, 'session', 's-2');
  });

  it('never writes one session position onto another session, mid-flight', async () => {
    // The reproduction: `MessageList` is not remounted when the operator
    // switches conversation, so a write still in flight for session A outlives
    // the view of A. With a queue that carried only a number, the drain picked
    // up B's position and wrote it to A — silently marking a conversation
    // nobody had read as read to the end.
    let releaseA: (value: ReadCursor) => void = () => {};
    const writes: [string, number][] = [];
    const setReadCursor = vi
      .fn()
      .mockImplementation((_kind: string, threadId: string, seq: number) => {
        writes.push([threadId, seq]);
        if (threadId === 's-A') {
          return new Promise<ReadCursor>((resolve) => {
            releaseA = resolve;
          });
        }
        return Promise.resolve(cursor(threadId, seq));
      });
    const { result, rerender } = setup(
      {
        getReadCursor: vi
          .fn()
          .mockImplementation(async (_kind: string, id: string) =>
            cursor(id, id === 's-A' ? 2 : 1)
          ),
        setReadCursor,
      },
      { sessionId: 's-A', messages: transcript(3) }
    );

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    act(() => result.current.markSeen());
    expect(writes).toEqual([['s-A', 3]]);

    // Switch to a much longer conversation while A's write is still in flight,
    // and mark it seen there.
    rerender({ id: 's-B', msgs: transcript(50) });
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    act(() => result.current.markSeen());

    await act(async () => {
      releaseA(cursor('s-A', 3));
    });
    await waitFor(() => expect(writes).toContainEqual(['s-B', 50]));

    expect(writes.filter(([id]) => id === 's-A')).toEqual([['s-A', 3]]);
    expect(
      writes.some(([id, seq]) => id === 's-A' && seq === 50),
      "session A must never be told session B's position"
    ).toBe(false);
  });

  it('lands the rule early rather than losing it when a reload adds a row', async () => {
    // The honest residual of counting positions: a reload whose history came
    // back with a row the last one did not have (a compaction boundary, a local
    // command's echo) shifts every position after it. The rule then sits one or
    // two messages EARLY — a couple of already-read messages under the line,
    // never a missed one — and the next mark clears it.
    const { result } = setup(
      { getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 3)) },
      {
        messages: [
          { id: 'compaction-boundary' },
          { id: 'm1' },
          { id: 'm2' },
          { id: 'm3' },
          { id: 'm4' },
        ],
      }
    );

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    // Position 3 of the reloaded transcript is what was position 2 before, so
    // the line sits above `m3` rather than above `m4`. Still drawn, still above
    // the unread ones.
    expect(result.current.lastSeenMessageId).toBe('m2');
  });

  it('learns who the reader is from a write when the read failed', async () => {
    // A failed read leaves no identity to filter broadcasts by; the first
    // successful write carries one, because the route only ever answers about
    // its caller.
    const { result } = setup({
      getReadCursor: vi.fn().mockRejectedValue(new Error('no answer')),
      setReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 3, 'author-me')),
    });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    act(() => result.current.markSeen());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    broadcast({
      userId: 'author-someone-else',
      threadKind: 'session',
      threadId: 's-1',
      lastReadSeq: 9,
    });

    expect(result.current.lastSeenMessageId).toBeNull();
    expect(result.current.unreadFromStart).toBe(false);
  });

  it('keeps a refused write from swallowing the broadcast that follows it', async () => {
    // The write raises what this client "knows" before it is made, so its own
    // echo cannot clear the rule. A refusal has to put that back, or a genuine
    // move to the same position — the other device reading to the same place —
    // would be dropped as an echo of a write that never landed.
    const { result } = setup({
      getReadCursor: vi.fn().mockResolvedValue(cursor('s-1', 1)),
      setReadCursor: vi.fn().mockRejectedValue(new Error('refused')),
    });

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    act(() => result.current.markSeen());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    broadcast({ userId: 'author-me', threadKind: 'session', threadId: 's-1', lastReadSeq: 3 });

    expect(result.current.lastSeenMessageId).toBeNull();
  });

  it('sweeps the retired watermark keys off this browser', async () => {
    window.localStorage.setItem('dorkos:chat:last-seen:s-1', 'm2');
    window.localStorage.setItem('dorkos:chat:last-seen:s-other', 'm9');
    window.localStorage.setItem('dorkos:ui:theme', 'dark');

    const { result } = setup({ getReadCursor: vi.fn().mockResolvedValue(null) });
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    // Every session's key goes, not only the open one — a browser that never
    // re-opens an old session would otherwise keep its watermark forever. And
    // nothing else in storage is touched.
    expect(window.localStorage.getItem('dorkos:chat:last-seen:s-1')).toBeNull();
    expect(window.localStorage.getItem('dorkos:chat:last-seen:s-other')).toBeNull();
    expect(window.localStorage.getItem('dorkos:ui:theme')).toBe('dark');
  });
});

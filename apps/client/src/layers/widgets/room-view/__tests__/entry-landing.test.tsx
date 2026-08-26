// @vitest-environment jsdom
/**
 * Landing a room on the one message a search hit named (DOR-687).
 *
 * Two halves, tested apart because they fail apart: which ROW draws a given
 * entry (`flowRowForEntry`, shared with the live peek), and what a room does
 * with `?entry=<seq>` once its history is here (`useEntryLanding`).
 *
 * Deliberately not about scrolling: jsdom lays nothing out, so "did it land"
 * is `Timeline.test.tsx`'s question in this repo and a browser's beyond it.
 * What is answerable here is which row is ASKED for, and what is said when
 * there is none.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { RoomEntry } from '@/layers/entities/room';
import { flowRowForEntry } from '../lib/room-timeline';
import { useEntryLanding } from '../model/use-entry-landing';

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { info: toastInfo } }));

// The open-thread store, stubbed at its seam: opening a thread is an action on
// a store the room shares, and what this file has to prove is that the hook
// takes it — the panel that results is `RoomThreadPanel`'s own claim.
const openThread = vi.hoisted(() => vi.fn());
vi.mock('@/layers/entities/room', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/room')>()),
  useRoomOpenThreadStore: { getState: () => ({ openThread }) },
}));

/** One committed entry, with only what the two functions under test read. */
function entry(id: string, seq: number, threadRootEntryId?: string): RoomEntry {
  return {
    id,
    seq,
    kind: 'post',
    authorId: 'author-kai',
    body: { text: id },
    createdAt: '2026-08-24T10:00:00.000Z',
    ...(threadRootEntryId === undefined ? {} : { threadRootEntryId }),
  } as unknown as RoomEntry;
}

const ROOT = entry('root', 10);
const REPLY = entry('reply', 11, 'root');
const ORPHAN = entry('orphan', 12, 'a-root-nobody-loaded');
const LATEST = entry('latest', 13);
const HISTORY = [ROOT, REPLY, ORPHAN, LATEST];

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('which row draws an entry', () => {
  it('gives a top-level entry its own row', () => {
    expect(flowRowForEntry(HISTORY, 'root')).toEqual({
      rowId: 'root',
      domId: 'room-entry-root',
    });
  });

  it('sends a reply to the thread row the flow draws for it', () => {
    // The room's flow does not draw replies (`groupByThread` keeps them out and
    // the panel shows them), so aiming at `room-entry-reply` would be aiming at
    // an element nothing renders. The "↳ N replies" row is where a room can
    // actually take you.
    expect(flowRowForEntry(HISTORY, 'reply')).toEqual({
      rowId: 'thread-root',
      domId: 'thread-row-root',
    });
  });

  it('gives an orphaned reply its own row, because the flow does draw that one', () => {
    // The case the two callers used to answer differently. A reply whose thread
    // head is not in this page is pushed into the flow itself and marked
    // orphaned — a room never drops a line of its log — so it has a row.
    expect(flowRowForEntry(HISTORY, 'orphan')).toEqual({
      rowId: 'orphan',
      domId: 'room-entry-orphan',
    });
  });

  it('answers nothing for an entry no loaded history holds', () => {
    expect(flowRowForEntry(HISTORY, 'never-read')).toBeNull();
  });
});

describe('what a room does with ?entry=', () => {
  /** Mount the hook the way `RoomSurface` does. */
  function landing(overrides: Partial<Parameters<typeof useEntryLanding>[0]> = {}) {
    return renderHook((props: Parameters<typeof useEntryLanding>[0]) => useEntryLanding(props), {
      initialProps: {
        roomId: 'room-1',
        entrySeq: 10 as number | undefined,
        entries: HISTORY as readonly RoomEntry[],
        historyLoaded: true,
        ...overrides,
      },
    });
  }

  it('asks for the row the seq names', () => {
    // `ordinal` on a room hit IS the entry's `seq`, which is the whole reason
    // this needed no new field on the wire. The ROW id — what the landing
    // matches — not the element's DOM id.
    expect(landing().result.current.roomRow?.()).toBe('root');
  });

  it('asks for nothing at all when no message was named', () => {
    // `undefined` rather than a getter answering `undefined`: the room's usual
    // landing must be left entirely alone, not handed a request it then has to
    // discard. Every way into a room except a search hit takes this path.
    const { result } = landing({ entrySeq: undefined });
    expect(result.current.roomRow).toBeUndefined();
    expect(result.current.threadRow).toBeUndefined();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('says the message is not here when the loaded history does not reach it', () => {
    // A room loads its trailing page and nothing pages backwards yet, so a hit
    // outside it has no row. Opening at the bottom in silence looks exactly
    // like a click that worked.
    const { result } = landing({ entrySeq: 3 });

    expect(result.current.roomRow?.()).toBeUndefined();
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith(
      "DorkOS can't find that message in what's open here",
      expect.objectContaining({ description: expect.any(String) as string })
    );
  });

  it('does not guess which DIRECTION the message is in', () => {
    // A stale or hand-edited address can name a `seq` this room has not reached
    // yet, so "older" would be a confident wrong answer where a plain sentence
    // costs nothing.
    landing({ entrySeq: 9999 });

    const [title, options] = toastInfo.mock.calls[0] as [string, { description: string }];
    expect(`${title} ${options.description}`).not.toMatch(/older|earlier|further back|back in/iu);
  });

  it('says it once, not once per render', () => {
    const { rerender, result } = landing({ entrySeq: 3 });
    rerender({ roomId: 'room-1', entrySeq: 3, entries: HISTORY, historyLoaded: true });
    rerender({ roomId: 'room-1', entrySeq: 3, entries: HISTORY, historyLoaded: true });

    expect(result.current).toBeDefined();
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('says nothing while the history is still arriving', () => {
    // The accusation has to wait for the evidence: an empty `entries` is what
    // every room looks like for the first moment, and reporting from it would
    // fire on every deep link ever followed.
    const { result } = landing({ entries: [], historyLoaded: false });

    expect(result.current.roomRow?.()).toBeUndefined();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('says nothing when the history arrives holding the message', () => {
    // The positive control for the two above: without it, a hook that reported
    // every link as out of reach would pass them both.
    const { result, rerender } = landing({ entries: [], historyLoaded: false });

    rerender({ roomId: 'room-1', entrySeq: 10, entries: HISTORY, historyLoaded: true });

    expect(result.current.roomRow?.()).toBe('root');
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

describe('a request is consumed once', () => {
  /** Mount the hook the way `RoomSurface` does. */
  function landing(entrySeq: number | undefined) {
    return renderHook((props: Parameters<typeof useEntryLanding>[0]) => useEntryLanding(props), {
      initialProps: {
        roomId: 'room-1',
        entrySeq,
        entries: HISTORY as readonly RoomEntry[],
        historyLoaded: true,
      },
    });
  }

  it('answers once and never again', () => {
    // **The remount defect this closes.** On a phone the thread panel unmounts
    // the room's timeline, so its landing runs afresh every time one is closed.
    // A request that kept answering would outrank `resumeRow` for the rest of
    // the room's life — throwing a reader at message 300 back to the message
    // they searched for, which is the exact thing `resumeRow` exists to
    // prevent.
    const { result } = landing(10);

    expect(result.current.roomRow?.()).toBe('root');
    expect(result.current.roomRow?.()).toBeUndefined();
    expect(result.current.roomRow?.()).toBeUndefined();
  });

  it('answers again for a NEW message in the same room', () => {
    // **The blocker this closes.** Clicking a hit in the room you are already
    // reading is an in-place search-param navigation: the room does not change,
    // so the timeline's own arm guard never lifts and only a fresh answer here
    // can move anything.
    const { result, rerender } = landing(10);
    expect(result.current.roomRow?.()).toBe('root');

    rerender({ roomId: 'room-1', entrySeq: 13, entries: HISTORY, historyLoaded: true });

    expect(result.current.roomRow?.()).toBe('latest');
  });

  it('answers again for the same seq in a DIFFERENT room', () => {
    // The marker is keyed on both, because `seq` is per-room: two rooms
    // routinely have a message numbered 10, and they are different messages.
    const { result, rerender } = landing(10);
    expect(result.current.roomRow?.()).toBe('root');

    rerender({ roomId: 'room-2', entrySeq: 10, entries: HISTORY, historyLoaded: true });

    expect(result.current.roomRow?.()).toBe('root');
  });

  it('gives the room and the thread panel their own answers', () => {
    // Two consumers, one request. A single marker would let whichever timeline
    // landed first eat the answer the other one needed — and on a reply hit,
    // both need one.
    const { result } = landing(11);

    expect(result.current.roomRow?.()).toBe('thread-root');
    expect(result.current.threadRow?.()).toBe('reply');
  });
});

describe('a hit on a thread reply', () => {
  /** Mount the hook the way `RoomSurface` does. */
  function landing(entrySeq: number) {
    return renderHook(() =>
      useEntryLanding({ roomId: 'room-1', entrySeq, entries: HISTORY, historyLoaded: true })
    );
  }

  it('opens the thread the reply is in, so the message is actually on screen', () => {
    // Landing the room on the "↳ N replies" row and stopping there puts a
    // reader on a collapsed count with the message they searched for nowhere in
    // the document. The panel is where the reply IS.
    landing(11);

    expect(openThread).toHaveBeenCalledWith('room-1', 'root');
  });

  it('lands the panel on the reply and the room on its thread row', () => {
    const { result } = landing(11);

    expect(result.current.threadRow?.()).toBe('reply');
    expect(result.current.roomRow?.()).toBe('thread-root');
  });

  it('opens no thread for a top-level message', () => {
    // The positive control: a hook that opened a thread for everything would
    // pass the test above, and would put a panel over the room on every hit.
    const { result } = landing(10);

    expect(openThread).not.toHaveBeenCalled();
    expect(result.current.threadRow?.()).toBeUndefined();
  });

  it('opens no thread for an orphaned reply, which the room draws itself', () => {
    // Its thread head is not in this page, so `groupByThread` puts it in the
    // flow and it has a row of its own. Opening a panel on a root nothing has
    // loaded would show a thread that says its start is gone, instead of the
    // message that is right there.
    const { result } = landing(12);

    expect(openThread).not.toHaveBeenCalled();
    expect(result.current.roomRow?.()).toBe('orphan');
  });
});

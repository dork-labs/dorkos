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
  function landing(
    overrides: Partial<Parameters<typeof useEntryLanding>[0]> = {}
  ): ReturnType<typeof renderHook<ReturnType<typeof useEntryLanding>, unknown>> {
    return renderHook(() =>
      useEntryLanding({
        roomId: 'room-1',
        entrySeq: 10,
        entries: HISTORY,
        historyLoaded: true,
        ...overrides,
      })
    );
  }

  it('asks for the row the seq names', () => {
    // `ordinal` on a room hit IS the entry's `seq`, which is the whole reason
    // this needed no new field on the wire.
    // The ROW id — what the landing matches — not the element's DOM id.
    expect(landing().result.current?.()).toBe('root');
  });

  it('asks for the thread row when the seq names a reply', () => {
    expect(landing({ entrySeq: 11 }).result.current?.()).toBe('thread-root');
  });

  it('asks for nothing at all when no message was named', () => {
    // `undefined` rather than a getter answering `undefined`: the room's usual
    // landing must be left entirely alone, not handed a request it then has to
    // discard. Every way into a room except a search hit takes this path.
    const { result } = landing({ entrySeq: undefined });
    expect(result.current).toBeUndefined();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('says the message is further back when the loaded history does not reach it', () => {
    // A room loads its trailing page and nothing pages backwards yet, so a hit
    // in an older part of a busy channel has no row. Opening at the bottom in
    // silence looks exactly like a click that worked.
    const { result } = landing({ entrySeq: 3 });

    expect(result.current?.()).toBeUndefined();
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith(
      'That message is further back',
      expect.objectContaining({ description: expect.stringContaining('older') as string })
    );
  });

  it('says it once, not once per render', () => {
    const { rerender } = landing({ entrySeq: 3 });
    rerender();
    rerender();

    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('says nothing while the history is still arriving', () => {
    // The accusation has to wait for the evidence: an empty `entries` is what
    // every room looks like for the first moment, and reporting from it would
    // fire on every deep link ever followed.
    const { result } = landing({ entries: [], historyLoaded: false });

    expect(result.current?.()).toBeUndefined();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('says nothing when the history arrives holding the message', () => {
    // The positive control for the two above: without it, a hook that reported
    // every link as out of reach would pass them both.
    const { result, rerender } = renderHook(
      ({ entries, historyLoaded }: { entries: RoomEntry[]; historyLoaded: boolean }) =>
        useEntryLanding({ roomId: 'room-1', entrySeq: 10, entries, historyLoaded }),
      { initialProps: { entries: [] as RoomEntry[], historyLoaded: false } }
    );

    rerender({ entries: HISTORY, historyLoaded: true });

    expect(result.current?.()).toBe('root');
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

/**
 * Landing a room on the one message a search hit named (DOR-687).
 *
 * @module widgets/room-view/model/use-entry-landing
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { threadRootIdOf, useRoomOpenThreadStore, type RoomEntry } from '@/layers/entities/room';
import { flowRowForEntry } from '../lib/room-timeline';

/** What deciding where a room opens on a deep link needs. */
export interface EntryLandingInput {
  /** The room on screen. */
  roomId: string;
  /** `?entry=` as it arrived — the `seq` of the message to land on. */
  entrySeq: number | undefined;
  /** The room's loaded history, whole (replies included). */
  entries: readonly RoomEntry[];
  /** Whether that history has actually arrived. */
  historyLoaded: boolean;
}

/**
 * Where a room and its thread panel should each open, for one request.
 *
 * **Two getters rather than one, because a reply is drawn in two places and
 * neither of them alone is where the reader wants to be.** The room's flow does
 * not draw replies — it draws the "↳ N replies" row of the thread they are in —
 * so landing a room on a reply hit and stopping there lands somebody on a
 * collapsed count with the message they searched for nowhere on screen. The
 * panel is where the reply itself is, so the panel is opened and lands on it,
 * and the room lands on the thread row behind it. One click, both halves.
 *
 * Each getter carries its OWN consumed-marker: they are two consumers of one
 * request, and a single marker would let whichever timeline landed first eat
 * the answer the other one needed.
 */
export interface EntryLanding {
  /**
   * The row the ROOM's flow should open on, or `undefined` when nothing was
   * asked for. Reading it consumes the room's half of the request.
   */
  roomRow: (() => string | undefined) | undefined;
  /**
   * The row the THREAD PANEL should open on, when the hit is a reply. Reading
   * it consumes the panel's half.
   */
  threadRow: (() => string | undefined) | undefined;
}

/**
 * Take a room to the message `?entry=` names, opening its thread when it is in
 * one, and say one honest sentence when the message is not here.
 *
 * **A room hit's `ordinal` IS an entry's `seq`** (`SearchHitSchema`), so the
 * coordinate the message index already returns is enough to become an address —
 * no new field on the wire, and no second numbering to keep in step with the
 * first. What is NOT free is turning a `seq` into a ROW: the flow draws replies
 * inside their thread rather than in the room, so the row a person should be
 * taken to is `flowRowForEntry`'s answer and not "the element for this entry".
 *
 * **The result is a pair of GETTERS, handed to the timelines' landings rather
 * than fired at them.** A room opens at its newest message through a one-shot
 * layout effect (`useTimelineLanding`); an effect of this hook's own would run
 * after that on a cold load and before it on a warm one, so a link would land
 * correctly or at the bottom depending on whether the history happened to be
 * cached. Answering a question the landing asks removes the race instead of
 * usually winning it.
 *
 * **A request is consumed once, and that is what makes it a request rather than
 * a setting.** The marker is keyed on the room AND the `seq`, so:
 *
 * - A NEW `?entry=` in a room already on screen re-arms the landing, which is
 *   the whole of "search for something in the room you are already reading".
 *   The timeline's own arm guard is per conversation and an in-place
 *   search-param navigation never trips it.
 * - An ANSWERED one stops answering, so it cannot outrank `resumeRow` on a
 *   remount. On a phone the thread panel unmounts the room's timeline; a
 *   request that kept answering would throw a reader at message 300 back to the
 *   message they searched for every time they closed a thread.
 *
 * **A `seq` this page of history does not hold gets a sentence, not silence.**
 * The room loads its trailing page and nothing pages backwards yet
 * (`useRoomEntries`), so a hit outside it has no row to land on — and a click
 * that quietly opens the room at the bottom looks exactly like a click that
 * worked. One quiet line says which of the two happened. `toast.info`, matching
 * the way the search box already reports a working directory that is gone: it
 * qualifies something already on screen.
 *
 * @param input - The room, the requested `seq`, and the loaded history.
 * @returns Where the room's flow and its thread panel should each open.
 */
export function useEntryLanding(input: EntryLandingInput): EntryLanding {
  const { roomId, entrySeq, entries, historyLoaded } = input;

  /** This request's identity — what every one-shot below is keyed on. */
  const request = entrySeq === undefined ? null : `${roomId}:${entrySeq}`;

  const resolved = useMemo(() => {
    if (entrySeq === undefined) return null;
    const entry = entries.find((candidate) => candidate.seq === entrySeq);
    if (entry === undefined) return null;
    // The ROW id, not the element's: the landing matches `ConversationRow.id`,
    // and handing it a DOM id fails silently — the room just opens at the
    // bottom, which looks exactly like a link that was never followed.
    const row = flowRowForEntry(entries, entry.id);
    if (row === null) return null;
    // `?? null` because `threadRootIdOf` reads two OPTIONAL fields and can
    // answer `undefined` in spite of its `string | null` signature. A reply
    // whose root this page does not hold is drawn in the flow itself, and
    // `flowRowForEntry` has already said so by answering with its own row — so
    // the thread is only opened when the room really does hide the message.
    const rootId = threadRootIdOf(entry) ?? null;
    const inThread = rootId !== null && row.rowId !== entry.id;
    return { roomRowId: row.rowId, threadRootId: inThread ? rootId : null, entryId: entry.id };
  }, [entries, entrySeq]);

  // Open the thread the message is inside, so the panel has it on screen while
  // the room behind lands on the thread's row. The store is the source of truth
  // for an open thread and `useThreadUrlSync` mirrors it into `?thread=`, so
  // this needs no second address of its own.
  const openedRef = useRef<string | null>(null);
  const threadRootId = resolved?.threadRootId ?? null;
  useEffect(() => {
    if (request === null || threadRootId === null) return;
    if (openedRef.current === request) return;
    openedRef.current = request;
    // Reading, not writing: the panel takes no caret and the keyboard stays
    // shut, the same way opening a thread from a reply row does.
    useRoomOpenThreadStore.getState().openThread(roomId, threadRootId);
  }, [request, roomId, threadRootId]);

  // Which request has already been reported on, so the sentence is said once
  // per link rather than on every re-render of a room that cannot show it.
  const toldRef = useRef<string | null>(null);
  useEffect(() => {
    if (request === null || !historyLoaded) return;
    if (resolved !== null) return;
    if (toldRef.current === request) return;
    toldRef.current = request;
    // Direction-neutral on purpose. "Older" would be a guess: a hand-edited or
    // stale address can name a `seq` this room has not reached yet, and telling
    // somebody a message is in the past when it is in the future is a confident
    // wrong answer where a plain one costs nothing.
    toast.info("DorkOS can't find that message in what's open here", {
      description:
        'This conversation has its most recent messages open, and that one is not among them. Everything said here is still here.',
    });
  }, [request, historyLoaded, resolved]);

  // One consumed-marker per consumer: see `EntryLanding`.
  const roomConsumedRef = useRef<string | null>(null);
  const roomRow = useCallback(() => {
    if (request === null || roomConsumedRef.current === request) return undefined;
    roomConsumedRef.current = request;
    return resolved?.roomRowId;
  }, [request, resolved]);

  const threadConsumedRef = useRef<string | null>(null);
  const threadRow = useCallback(() => {
    if (request === null || threadConsumedRef.current === request) return undefined;
    threadConsumedRef.current = request;
    // The panel numbers its rows by entry id, the same as the flow does.
    return resolved?.threadRootId === null ? undefined : resolved?.entryId;
  }, [request, resolved]);

  return {
    roomRow: entrySeq === undefined ? undefined : roomRow,
    threadRow: entrySeq === undefined ? undefined : threadRow,
  };
}

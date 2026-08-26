/**
 * Landing a room on the one message a search hit named (DOR-687).
 *
 * @module widgets/room-view/model/use-entry-landing
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import type { RoomEntry } from '@/layers/entities/room';
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
 * The row id `?entry=` names, and one honest sentence when it names nothing.
 *
 * **A room hit's `ordinal` IS an entry's `seq`** (`SearchHitSchema`), so the
 * coordinate the message index already returns is enough to become an address —
 * no new field on the wire, and no second numbering to keep in step with the
 * first. What is NOT free is turning a `seq` into a ROW: the flow draws replies
 * inside their thread rather than in the room, so the row a person should be
 * taken to is `flowRowForEntry`'s answer and not "the element for this entry".
 *
 * **The result is a GETTER, handed to the timeline's landing rather than fired
 * at it.** A room opens at its newest message through a one-shot layout effect
 * (`useTimelineLanding`); an effect of this hook's own would run after that on
 * a cold load and before it on a warm one, so a link would land correctly or at
 * the bottom depending on whether the history happened to be cached. Answering
 * a question the landing asks removes the race instead of usually winning it.
 *
 * **A `seq` this page of history does not hold gets a sentence, not silence.**
 * The room loads its trailing page and nothing pages backwards yet
 * (`useRoomEntries`), so a hit in an older part of a busy channel has no row to
 * land on — and a click that quietly opens the room at the bottom looks exactly
 * like a click that worked. One quiet line says which of the two happened.
 * `toast.info`, matching the way the search box already reports a working
 * directory that is gone: it qualifies something already on screen.
 *
 * @param input - The room, the requested `seq`, and the loaded history.
 * @returns A getter answering the row id to open on, or `undefined` when
 *   nothing was asked for — which leaves the room's usual landing alone.
 */
export function useEntryLanding(input: EntryLandingInput): (() => string | undefined) | undefined {
  const { roomId, entrySeq, entries, historyLoaded } = input;

  const rowId = useMemo(() => {
    if (entrySeq === undefined) return undefined;
    const entry = entries.find((candidate) => candidate.seq === entrySeq);
    if (entry === undefined) return undefined;
    // The ROW id, not the element's: the landing matches `ConversationRow.id`,
    // and handing it a DOM id fails silently — the room just opens at the
    // bottom, which looks exactly like a link that was never followed.
    return flowRowForEntry(entries, entry.id)?.rowId;
  }, [entries, entrySeq]);

  // Which request has already been reported on, so the sentence is said once
  // per link rather than on every re-render of a room that cannot show it.
  const toldRef = useRef<string | null>(null);
  const request = entrySeq === undefined ? null : `${roomId}:${entrySeq}`;

  useEffect(() => {
    if (request === null || !historyLoaded) return;
    if (rowId !== undefined) return;
    if (toldRef.current === request) return;
    toldRef.current = request;
    toast.info('That message is further back', {
      description:
        'This conversation only has its most recent messages open, and the one you picked is older than those. Everything said here is still here.',
    });
  }, [request, historyLoaded, rowId]);

  // A stable getter identity would be nicer, but the landing reads it once and
  // is guarded against running twice, so a new function per resolved row costs
  // nothing and keeps the answer honest as the history arrives.
  const landOnRow = useCallback(() => rowId, [rowId]);
  return entrySeq === undefined ? undefined : landOnRow;
}

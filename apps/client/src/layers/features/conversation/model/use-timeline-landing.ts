/**
 * Where a conversation lands when you open it, and what it remembers.
 *
 * Split out of `Conversation.Timeline` because it is a self-contained decision
 * with its own traps: it runs once per conversation, it has to wait for the
 * virtualizer to have geometry, and it answers in ROWS rather than pixels.
 * The timeline keeps the scroller, the rows and the virtualizer; this owns the
 * one moment those three first agree on where the reader belongs.
 *
 * @module features/conversation/model/use-timeline-landing
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { ConversationRow } from '../lib/row-kinds';

/** What the landing needs to decide where to put the reader. */
export interface TimelineLandingInput {
  /** The conversation on screen — changing it is what re-arms the decision. */
  conversationId: string;
  /** The rows, oldest first, exactly as the timeline draws them. */
  rows: readonly ConversationRow[];
  /** The list's own virtualizer, which is what actually moves. */
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** `end` — the newest row — or `unread`, the rule with one row of context above it. */
  landOn: 'unread' | 'end';
  /** Whether the decision can be made yet. A session waits for its read cursor. */
  landingReady: boolean;
  /**
   * The row this conversation was left on, asked for at landing time.
   *
   * A GETTER, and the HOST holds the answer — which is what makes it work at
   * all. On a phone the thread panel is a full-screen push that unmounts the
   * whole timeline, so the memory has to live somewhere that survives it, and
   * the host is the only thing that does.
   */
  resumeRow?: () => string | undefined;
  /**
   * Told which row is at the top of the viewport, or `undefined` while the
   * reader is caught up at the bottom — which is the host's cue to forget.
   */
  onTopRow?: (rowId: string | undefined) => void;
}

/** What the timeline gets back. */
export interface TimelineLanding {
  /**
   * True once the landing has run.
   *
   * The wait before anything may read the list as "at the bottom":
   * `isAtEnd()` is vacuously true before the virtualizer has geometry, and
   * reading a session as pinned is what marks it read.
   */
  landed: boolean;
  /**
   * What the landing decided, for the wrapper's `data-landed-on`.
   *
   * A `data-` attribute rather than a log, because the question it answers —
   * "did this conversation come back to the row the reader was on, or open at
   * its newest message?" — is only answerable in a browser, and a browser test
   * needs something to read. `null` until the landing has run.
   */
  landedOn: string | null;
  /** Call from the scroll handler: tells the host which row is at the top. */
  reportTopRow: (scroller: HTMLElement | null, atBottom: boolean) => void;
}

/**
 * Decide where a conversation opens, ONCE per conversation, on the first render
 * that has rows.
 *
 * A reader coming back from a thread panel — which UNMOUNTS the whole timeline
 * on a phone — belongs where they were standing, so a restored position wins
 * outright and everything else stands down. With `landOn: 'unread'` and a rule
 * on screen, land on the rule: landing at the end makes the list pinned, which
 * marks everything seen and overwrites the very cursor that drew the rule.
 * Otherwise land on the newest row, exactly as every chat surface does.
 * (`anchorTo`/`followOnAppend` only engage after the first mount.)
 *
 * TRAP: the virtualizer knows nothing on the first commit. Its scroll element is
 * attached by its own layout effect and its rows are measured after that, so a
 * `scrollToIndex` issued from the first commit is aimed at a list with no
 * geometry — it lands at zero and the settle silently carries it there. Measured
 * in a browser on a phone: asked for the row the reader was on, arrived at the
 * oldest message of the loaded page. `measured` is the wait, and it is declared
 * BEFORE the landing so the landing runs on the commit after it.
 *
 * @param input - The conversation, its rows, and where it should open.
 * @returns Whether it has landed, what it decided, and the scroll reporter.
 */
export function useTimelineLanding(input: TimelineLandingInput): TimelineLanding {
  const { conversationId, rows, virtualizer, landOn, landingReady, resumeRow, onTopRow } = input;

  const [measured, setMeasured] = useState(false);
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the mount IS the event: this is the commit on which the virtualizer first has a scroll element, and there is no other way to hear it
    setMeasured(true);
  }, []);

  const anchoredRef = useRef<string | null>(null);
  const [landed, setLanded] = useState(false);
  const [landedOn, setLandedOn] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!measured || !landingReady || anchoredRef.current === conversationId) return;
    if (rows.length === 0) return;
    anchoredRef.current = conversationId;
    /* eslint-disable react-hooks/set-state-in-effect -- landing is a one-shot event guarded by `anchoredRef`, and what it decided has to be readable from the DOM (`data-landed-on`); it cannot be derived during render because it depends on the virtualizer having geometry */
    // A reader coming back belongs on the row they were reading. Asked for by
    // INDEX rather than by offset, because the virtualizer's total height is an
    // estimate on the first commit and settles over the next few frames — a
    // remembered PIXEL cannot survive that, and this was measured: restored to
    // 900px, the list settled from an estimated 16 000px to a measured 4 159px,
    // and `anchorTo: 'end'` carried the offset down past zero.
    setLanded(true);
    const remembered = resumeRow?.();
    if (remembered !== undefined) {
      const index = rows.findIndex((row) => row.id === remembered);
      if (index !== -1) {
        setLandedOn('remembered');
        virtualizer.scrollToIndex(index, { align: 'start' });
        return;
      }
    }
    const unreadIndex =
      landOn === 'unread' ? rows.findIndex((row) => row.kind === 'unread-divider') : -1;
    if (unreadIndex === -1) {
      setLandedOn(remembered === undefined ? 'end' : 'end-row-gone');
      virtualizer.scrollToEnd();
      return;
    }
    setLandedOn('unread');
    // One row of context above the rule, so the last already-seen message is
    // still on screen. Landing the rule flush at the viewport top loses the
    // "here is what you already read" edge that makes it legible.
    virtualizer.scrollToIndex(Math.max(0, unreadIndex - 1), { align: 'start' });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [measured, landingReady, conversationId, rows, virtualizer, landOn, resumeRow]);

  const reportTopRow = useCallback(
    (scroller: HTMLElement | null, atBottom: boolean) => {
      // The first VISIBLE row, not the first DRAWN one: the virtualizer keeps a
      // few rows of overscan above the viewport, and remembering one of those
      // put a returning reader five messages higher than they had been. Read off
      // the virtual items rather than the DOM — a `getBoundingClientRect` per
      // scroll event is exactly the cost virtualizing was for.
      //
      // `undefined` while the reader is caught up at the bottom: a conversation
      // left at its newest message opens at its newest message, and a remembered
      // row already on screen would be a landing with nothing to do.
      const top = scroller?.scrollTop ?? 0;
      const visible = virtualizer.getVirtualItems().find((item) => item.end > top);
      const id = visible === undefined ? undefined : rows[visible.index]?.id;
      onTopRow?.(atBottom ? undefined : id);
    },
    [virtualizer, rows, onTopRow]
  );

  return { landed, landedOn, reportTopRow };
}

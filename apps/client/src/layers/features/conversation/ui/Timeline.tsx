/**
 * `Conversation.Timeline` — the one virtualized list every surface draws.
 *
 * Built by porting the session's `MessageList` (the virtualized one) and
 * folding in the three things the room's `RoomTimeline` did that it did not:
 * the pending rows drawn under the log, the scroller's own memory, and a room's
 * thread rows. Both of those files are gone.
 *
 * **What it owns, and what the host owns.** This owns the scroller, the feed
 * semantics, the rows waiting under the log, and the imperative handle that
 * takes somebody to a row; the measurement contract, the landing, the edge
 * hand-back, the thumb and the two scrolled-away affordances are each their own
 * file beside it. The HOST owns what a row looks like:
 * `renderRow` is called for every row, so a session draws `SessionMessage` and
 * a channel draws `RoomMessage`, both of them built from the same `Message.*`
 * parts. That seam is deliberate — the two rows differ in what they KNOW (a
 * session's tool handles, a room's roster and reactions), not in how they are
 * laid out, and forcing one component to know both would put the surfaces back
 * inside each other.
 *
 * **Nothing here reads `surface`.** Threads open when `capabilities.threads`
 * says so, and that is the only branch in the file.
 *
 * @module features/conversation/ui/Timeline
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type Ref,
} from 'react';
import { cn } from '@/layers/shared/lib';
import { Feed } from '@/layers/shared/ui';
import type { PendingPost } from '@/layers/entities/room';
import type { ConversationRow, ConversationRowRenderer } from '../lib/row-kinds';
import { useConversation } from '../model/conversation-context';
import { useFeedEdgeFocus } from '../model/use-feed-edge-focus';
import { useTimelineLanding, type TimelineLanding } from '../model/use-timeline-landing';
import { useTimelineVirtualizer } from '../model/use-timeline-virtualizer';
import { useTimelineScroll } from '../model/use-timeline-scroll';
import { PendingRow } from './rows/PendingRow';
import { ScrollThumb } from './ScrollThumb';
import { TimelineAffordances } from './TimelineAffordances';

/**
 * How long the landing mark stays on the row it lands you on, in milliseconds.
 *
 * Long enough to be seen by somebody whose eyes were on the search box when the
 * scroll happened, short enough that it is gone before it becomes furniture.
 * The caret stays either way, so nothing is lost when it fades.
 *
 * Exported so the test that proves the mark is taken off again waits on the
 * shipped number rather than a copy of it that can drift.
 */
export const LANDING_MARK_MS = 2200;

/** What a caller can make the timeline do. */
export interface ConversationTimelineHandle {
  /**
   * Scroll a row into view and leave the reader standing on it.
   *
   * **Focus IS the flash**, and deliberately so: every row is already a focus
   * target with a ring, so landing the caret on one marks it, keeps it marked
   * while the reader looks, and puts a keyboard reader in the same place a
   * mouse reader is — which a fading highlight does for neither.
   *
   * It takes a DOM id rather than a row id, because the caller is the one that
   * knows WHICH element it is aiming at: a thread's root is drawn twice on a
   * wide screen, and a reply the room does not draw is best reached through its
   * thread's own row. Only rows on screen exist in the DOM, so a row outside the
   * rendered window is scrolled into existence first — {@link
   * ConversationTimelineProps.domIdOf} is what makes that possible.
   *
   * @param domId - The DOM id of the row to go to.
   * @param opts - `flash` is accepted for callers that want to say so; focus is
   *   the mark either way.
   * @returns Whether a row with that id could be reached.
   */
  scrollToRow(domId: string, opts?: { flash?: boolean }): boolean;
  /** Take the reader to the newest row. */
  scrollToBottom(opts?: { behavior?: ScrollBehavior }): void;
}

/** What {@link ConversationTimeline} needs to draw a conversation. */
export interface ConversationTimelineProps {
  /**
   * The conversation on screen — a session id or a room id.
   *
   * What keys on it: the landing, which runs once per conversation and re-arms
   * when this changes, and the scroller's own "you asked for somewhere else"
   * reset. Where the reader was STANDING is not kept here — that is
   * {@link ConversationTimelineProps.resumeRow}, which the host holds, because
   * on a phone this whole component is unmounted while a thread is open.
   */
  conversationId: string;
  /**
   * What the feed is called to a screen reader.
   *
   * A page can hold more than one scrollable history — a room and its open
   * thread — so "Messages" alone would leave a reader unable to say which one
   * they had landed in.
   */
  label: string;
  /** The rows to draw, oldest first, already grouped. */
  rows: readonly ConversationRow[];
  /** Draws one of them. */
  renderRow: ConversationRowRenderer;
  /** Open one row's thread. Ignored unless `capabilities.threads`. */
  onOpenThread?: (rootId: string) => void;
  /**
   * The DOM id the host puts on a row, for {@link
   * ConversationTimelineHandle.scrollToRow}.
   *
   * Only surfaces that address their rows need one; a session does not, so it
   * passes nothing and the handle answers from the document alone.
   */
  domIdOf?: (row: ConversationRow) => string | undefined;
  /**
   * Where the conversation opens.
   *
   * `end` — the newest message — is what every chat surface does and the
   * default. `unread` lands on the rule instead, one row above it so the last
   * already-seen message is still on screen; a surface asks for it when its
   * read cursor only moves while the reader is AT the bottom. A room's does
   * not: opening a room marks it read, so landing on a rule there would be
   * landing on something the same commit is erasing.
   */
  landOn?: 'unread' | 'end';
  /**
   * The row this conversation was left on, asked for at landing time.
   *
   * A GETTER, and the HOST holds the answer — which is what makes it work at
   * all. On a phone the thread panel is a full-screen push that unmounts this
   * whole component, so the memory has to live somewhere that survives it, and
   * the host is the only thing that does. A getter rather than a value because
   * the host is told on every scroll: a prop would re-render the host, and its
   * own state would re-render the room under the reader's finger.
   */
  resumeRow?: () => string | undefined;
  /**
   * The one row this conversation was ASKED to open on — a message somebody
   * searched for and clicked (DOR-687).
   *
   * A getter returning a row id, read at landing time, and it outranks every
   * other landing: see `TimelineLandingInput.landOnRow`. The row is centred and
   * the caret is put on it, so the reader can see WHICH message answered them —
   * the same "focus IS the flash" mark {@link
   * ConversationTimelineHandle.scrollToRow} leaves, for the same reason.
   *
   * Marking it needs {@link ConversationTimelineProps.domIdOf}; a host that
   * addresses no rows still gets the scroll, just not the caret.
   */
  landOnRow?: () => string | undefined;
  /**
   * Told which row is at the top of the viewport, or `undefined` while the
   * reader is caught up at the bottom — which is the host's cue to forget.
   */
  onTopRow?: (rowId: string | undefined) => void;
  /**
   * Whether the landing decision can be made yet.
   *
   * A session reads its cursor over the wire, so landing on the first render
   * with rows would put every conversation at the end — and being at the end is
   * what marks it read, so the rule would be consumed a frame before it could
   * be drawn. Defaults to `true` for surfaces whose cursor is already in hand.
   */
  landingReady?: boolean;
  /** Messages this reader has sent that the conversation has not echoed back. */
  pending?: readonly PendingPost[];
  /** This reader's own author id here, which a pending row's retry reads. */
  viewerAuthorId?: string;
  /** Drawn instead of the list while the first page of history is loading. */
  loading?: ReactNode;
  /** Drawn instead of the list when there is nothing in the conversation. */
  empty?: ReactNode;
  /**
   * The turn happening NOW, mirrored into a `role="log"` region.
   *
   * The region is mounted only when this prop is PROVIDED, empty string
   * included: a surface that never announces anything should not grow two silent
   * live regions for a screen reader to trip over.
   */
  transcriptAnnouncement?: ReactNode;
  /** A permission request getting its answer, mirrored into a `role="status"`. */
  approvalAnnouncement?: ReactNode;
  /**
   * Called on every commit where the reader is at the bottom with real geometry
   * behind that answer. Reading at the bottom is what marks a session read.
   */
  onReachedBottom?: () => void;
  /**
   * True while the history behind these rows is still arriving.
   *
   * The ONLY wait a conversation has, which is why it is the only thing that
   * sets `aria-busy`. Distinct from {@link ConversationTimelineProps.loading},
   * which replaces the list outright: a thread deep-linked before its room has
   * loaded draws what it has and says it is still waiting.
   */
  busy?: boolean;
  /** Extra classes for the scroller. */
  className?: string;
  /**
   * Test hook for the element wrapping the scroller.
   *
   * Two hooks rather than one because the shipped browser suites address both
   * boxes and mean different things by them: one page object reads the SCROLLER
   * by walking up from the feed, and another reads the wrapper the affordances
   * hang off. Renaming either would be a rename with no reader.
   */
  'data-testid'?: string;
  /** Test hook for the feed itself, which is the scroller's only child. */
  feedTestId?: string;
  /** The imperative handle. */
  ref?: Ref<ConversationTimelineHandle>;
}

/**
 * Draw a conversation's history.
 *
 * **It is a feed** (WAI-ARIA `role="feed"`), which is what makes crossing a
 * long conversation bearable without a mouse: Page Down and Page Up step
 * message to message however much each one carries, and Ctrl+Home / Ctrl+End
 * leave for the controls around it.
 *
 * Only the rows on screen exist in the DOM. Page Down at the edge of that
 * window would otherwise dead-end with the key swallowed and nothing rendered
 * to move to, so the feed hands the edge back (`onBeyondRendered`) and
 * `use-feed-edge-focus` scrolls the next article into existence and lands the
 * focus on it.
 *
 * Both of those depend on the HOST numbering its articles, and only one of the
 * two shipped hosts does — see `use-feed-edge-focus`.
 *
 * @param props - The rows, how to draw one, and where to open.
 */
export function ConversationTimeline({
  conversationId,
  label,
  rows,
  renderRow,
  onOpenThread,
  domIdOf,
  landOn = 'end',
  landingReady = true,
  resumeRow,
  landOnRow,
  onTopRow,
  pending,
  viewerAuthorId,
  loading,
  empty,
  transcriptAnnouncement,
  approvalAnnouncement,
  onReachedBottom,
  busy,
  className,
  'data-testid': testId,
  feedTestId,
  ref,
}: ConversationTimelineProps) {
  const { capabilities } = useConversation();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pendingRows = pending ?? [];

  const scroll = useTimelineScroll({
    conversationId,
    // Everything drawn in the scroller, because everything in it can be the
    // arrival a reader scrolled away from — a message of somebody else's, and a
    // row of this reader's own waiting under the log.
    rowCount: rows.length + pendingRows.length,
  });

  // One element, two consumers: the hook reads the geometry off it, and so does
  // the thumb.
  const { scrollRef: attachScroller, atBottomRef } = scroll;
  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerRef.current = el;
      attachScroller(el);
    },
    [attachScroller]
  );

  // Re-read the reader's remembered top row whenever the virtualizer SETTLES,
  // not only when a scroll event fires — see the `onChange` note in
  // `useTimelineVirtualizer`. Both values are read through refs so this callback
  // can stay stable AND be handed to the virtualizer before the landing (which
  // is what produces `reportTopRow`) has run this render.
  const reportTopRowRef = useRef<TimelineLanding['reportTopRow'] | null>(null);
  const landedRef = useRef(false);
  const captureSettledTopRow = useCallback(() => {
    // Nothing to remember until the landing has placed the reader: before that
    // the scroller sits at offset 0, and a capture here would overwrite the very
    // row the landing is about to restore to.
    if (!landedRef.current) return;
    reportTopRowRef.current?.(scrollerRef.current, atBottomRef.current);
  }, [atBottomRef]);

  const virtualizer = useTimelineVirtualizer(rows, scrollerRef, captureSettledTopRow);

  // Where this conversation opens, and what it remembers — its own hook,
  // because the decision has traps (wait for geometry, answer in rows not
  // pixels) that have nothing to do with drawing a list.
  const { landed, landedOn, landedRow, reportTopRow } = useTimelineLanding({
    conversationId,
    rows,
    virtualizer,
    landOn,
    landingReady,
    ...(resumeRow === undefined ? {} : { resumeRow }),
    ...(landOnRow === undefined ? {} : { landOnRow }),
    ...(onTopRow === undefined ? {} : { onTopRow }),
  });

  // Keep the settle callback's refs current. Written in a layout effect rather
  // than during render (a render-phase ref write is what `react-hooks/refs`
  // forbids), and read only from the async `onChange` — never during render.
  useLayoutEffect(() => {
    reportTopRowRef.current = reportTopRow;
    landedRef.current = landed;
  });

  const handleScroll = useCallback(() => {
    scroll.onScroll();
    // Read off the ref rather than the state, because this runs inside the
    // scroll handler and the state is one render behind it.
    reportTopRow(scrollerRef.current, atBottomRef.current);
  }, [scroll, reportTopRow, atBottomRef]);

  // `isAtEnd()` is vacuously TRUE before the virtualizer has geometry: it
  // derives from `getMaxScrollOffset()`, which is 0 while `scrollElement` is
  // null. So a first-commit read says "pinned to the bottom" for a 500-message
  // transcript the landing has just taken to the middle — and reading a session
  // as pinned is what marks it read. `landed` is the wait: it is set by the
  // landing effect above, on the commit where the list has both a scroll
  // element and a decision.
  const isAtEnd = virtualizer.isAtEnd();
  useEffect(() => {
    if (landed && isAtEnd) onReachedBottom?.();
  }, [landed, isAtEnd, onReachedBottom]);

  const handleBeyondRendered = useFeedEdgeFocus(rows, virtualizer, scrollerRef);

  /**
   * Land the caret on a row once it exists.
   *
   * Split from the handle because a row outside the rendered window needs a
   * commit to exist at all, so the same landing has to be reachable both
   * synchronously and a frame later.
   */
  const focusRowElement = useCallback((domId: string): boolean => {
    const row = document.getElementById(domId);
    if (row === null) return false;
    row.scrollIntoView({ block: 'center' });
    // `preventScroll`, because the line above has already put the row exactly
    // where it should be and the browser's own focus scroll would move it again.
    row.focus({ preventScroll: true });
    return true;
  }, []);

  /**
   * The row currently wearing the landing mark, so it can be taken off again.
   *
   * The element rather than its id: the row may be virtualized away before the
   * mark expires, and an id lookup would then find nothing to clean.
   */
  const markedElementRef = useRef<HTMLElement | null>(null);
  /**
   * The mark's own expiry, held in a ref rather than in the effect's cleanup.
   *
   * A timer owned by the effect is cancelled every time the effect's deps move
   * — and `rows` moves on every arriving message — so the mark would be applied
   * and then never taken off again in exactly the busy rooms where it matters.
   */
  const markExpiryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearLandingMark = useCallback(() => {
    if (markExpiryRef.current !== undefined) {
      clearTimeout(markExpiryRef.current);
      markExpiryRef.current = undefined;
    }
    markedElementRef.current?.removeAttribute('data-landed');
    markedElementRef.current = null;
  }, []);

  /**
   * Mark the row the landing was ASKED for, once it exists.
   *
   * The landing scrolls; this is what says *this one*. It cannot be part of the
   * landing itself, which works in row ids and has no idea what element any of
   * them is: only the host's {@link ConversationTimelineProps.domIdOf} knows
   * that, and only a frame after `scrollToIndex` does the element exist.
   *
   * **Two marks, because one of them does not reliably paint.** The caret is
   * the durable one and the reason the row is focused at all — it survives, it
   * is where the keyboard now is, and it is what `scrollToRow` already
   * documents. But a row focused PROGRAMMATICALLY after a mouse click does not
   * match `:focus-visible`, so on the mouse path — which is how a search result
   * is clicked — the ring a reader was promised may never be drawn. So the row
   * also wears `data-landed` for a moment, which is styled unconditionally
   * (`index.css`) and fades out on its own. Calm rather than a flash: it says
   * *here* and then stops talking.
   *
   * Keyed on the ROW, not the conversation, so a second search inside the same
   * room marks the new message. `landedRow` is read from the landing rather
   * than by asking `landOnRow` again, which would consume a request that has
   * not been made yet.
   */
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (landedOn !== 'requested' || landedRow === null) return;
    if (markedRef.current === landedRow) return;
    if (domIdOf === undefined) return;
    const row = rows.find((r) => r.id === landedRow);
    const domId = row === undefined ? undefined : domIdOf(row);
    if (domId === undefined) return;
    // A frame later, because virtualization is why the row was not in the
    // document before the landing moved to it.
    //
    // **`markedRef` is written INSIDE the frame, not before it**, and that is
    // the difference between a mark and no mark at all. Writing it up here
    // meant a re-render arriving in the gap — a settling roster, one live
    // message — cancelled the frame through this effect's cleanup and then
    // refused to re-schedule, because the row already counted as marked. The
    // room landed correctly and said nothing about it, which was measured at
    // the page rather than reasoned about.
    const frame = requestAnimationFrame(() => {
      if (!focusRowElement(domId)) return;
      const element = document.getElementById(domId);
      if (element === null) return;
      markedRef.current = landedRow;
      clearLandingMark();
      element.setAttribute('data-landed', 'true');
      markedElementRef.current = element;
      markExpiryRef.current = setTimeout(clearLandingMark, LANDING_MARK_MS);
    });
    return () => cancelAnimationFrame(frame);
  }, [landedOn, landedRow, domIdOf, rows, focusRowElement, clearLandingMark]);

  // The mark belongs to a moment, not to the room: a reader who scrolls has
  // stopped needing to be told where they landed, and a timeline going away
  // must not leave an attribute on a row a later render reuses.
  useEffect(() => clearLandingMark, [clearLandingMark]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToRow(domId: string): boolean {
        if (focusRowElement(domId)) return true;
        if (domIdOf === undefined) return false;
        const index = rows.findIndex((row) => domIdOf(row) === domId);
        if (index === -1) return false;
        // Scrolled into existence first: virtualization is why the element was
        // not there to begin with, and `scrollIntoView` cannot reach a node the
        // document does not hold.
        virtualizer.scrollToIndex(index, { align: 'center' });
        requestAnimationFrame(() => focusRowElement(domId));
        return true;
      },
      scrollToBottom(opts) {
        scroll.scrollToBottom(opts);
        virtualizer.scrollToEnd();
      },
    }),
    [focusRowElement, domIdOf, rows, virtualizer, scroll]
  );

  const rowContext = useMemo(
    () => ({ onOpenThread: capabilities.threads ? onOpenThread : undefined }),
    [capabilities.threads, onOpenThread]
  );

  if (loading != null) return <>{loading}</>;
  if (empty !== undefined && rows.length === 0 && pendingRows.length === 0) return <>{empty}</>;

  return (
    <div
      data-slot="conversation-timeline"
      data-testid={testId}
      data-landed-on={landedOn ?? undefined}
      className={cn('relative min-h-0 flex-1', className)}
    >
      <div
        ref={setScroller}
        onScroll={handleScroll}
        data-slot="conversation-scroller"
        data-testid="conversation-scroller"
        className="chat-scroll-area h-full scrollbar-none overflow-y-auto"
        style={{ overflowAnchor: 'none' }}
      >
        <Feed
          label={label}
          busy={busy}
          data-testid={feedTestId}
          onBeyondRendered={handleBeyondRendered}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: 'relative',
              width: '100%',
            }}
          >
            {/*
              ONE box holding the drawn window, rather than a position on every
              row — and the difference is not cosmetic. A per-row
              `position: absolute` makes each row its own containing block,
              which is what a message's sticky action rail is measured against:
              on a message taller than the window the bar stopped riding the
              viewport edge and sat at the row's own top instead
              (`room-entry-actions.spec.ts` measured it 66px low). It also made
              a row's reply line stop being its DOM sibling. One box moves the
              whole window and leaves the rows in ordinary flow, where both of
              those are true again.

              And the box moves by `top`, NOT by `transform` — a transform on
              an ancestor is itself a containing block for `position: fixed`
              AND the reference `position: sticky` clamps against, so the rail
              inside it stopped sticking the moment the window's offset went
              non-zero. Measured in Chromium on a 1528px message: with
              `translateY` the capsule sat 125px BELOW the scrollport; with the
              identical offset written as `top` it sat at +4px, which is what
              `sticky top-1` asks for. `room-entry-actions.spec.ts` posts filler
              entries before the tall one so the offset under test is non-zero,
              which is the only offset where the two differ.
            */}
            <div
              style={{
                position: 'absolute',
                top: virtualizer.getVirtualItems()[0]?.start ?? 0,
                left: 0,
                width: '100%',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => (
                <div
                  key={rows[virtualRow.index]!.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                >
                  {renderRow(rows[virtualRow.index]!, { ...rowContext, index: virtualRow.index })}
                </div>
              ))}
            </div>
          </div>
        </Feed>
        {/* Below the log, at the tail, where the message is about to appear —
            and outside the feed, because a message the server has not accepted
            yet is not one of its numbered articles. Outside the virtualizer too:
            there are never more than a handful, and giving them measured
            positions would make the total height move on every keystroke. */}
        {pendingRows.length > 0 && viewerAuthorId !== undefined && (
          <div className="flex flex-col">
            {pendingRows.map((post) => (
              <PendingRow key={post.clientId} post={post} viewerAuthorId={viewerAuthorId} />
            ))}
          </div>
        )}
      </div>

      {transcriptAnnouncement !== undefined && (
        /*
          The turn happening now, said out loud as it arrives — sentence by
          sentence, never the whole answer again. Rendered ALWAYS on a surface
          that announces at all, and emptied a few seconds after it speaks: a
          live region added to the page with words already in it is read out
          whole by most screen readers, so one left holding the last sentence
          would say it again on the next mount. Clearing is itself silent.
        */
        <div
          role="log"
          aria-live="polite"
          aria-atomic="false"
          data-testid="transcript-announcer"
          className="sr-only"
        >
          {transcriptAnnouncement}
        </div>
      )}
      {approvalAnnouncement !== undefined && (
        /*
          The answer to a permission request, confirmed out loud. Polite, not
          assertive: it reports something the reader just did, so it waits its
          turn rather than cutting in. Emptied after it speaks, for the same
          reason the log above is.
        */
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="approval-announcer"
          className="sr-only"
        >
          {approvalAnnouncement}
        </div>
      )}

      <ScrollThumb scrollRef={scrollerRef} />

      <TimelineAffordances
        hasNewRows={scroll.hasNewRows}
        isAtBottom={scroll.isAtBottom}
        hasRows={rows.length > 0}
        onJump={() => scroll.scrollToBottom({ behavior: 'smooth' })}
      />
    </div>
  );
}

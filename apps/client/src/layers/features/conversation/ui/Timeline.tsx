/**
 * `Conversation.Timeline` — the one virtualized list every surface draws.
 *
 * Built by porting the session's `MessageList` (the virtualized one) and
 * folding in the three things the room's `RoomTimeline` did that it did not:
 * the pending rows drawn under the log, the scroller's own memory, and a room's
 * thread rows. Both of those files are gone.
 *
 * **What it owns, and what the host owns.** This owns the scroller, the
 * virtualizer, the feed semantics, the thumb, the two affordances for a reader
 * who has scrolled away, the rows waiting under the log, and the imperative
 * handle that takes somebody to a row. The HOST owns what a row looks like:
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
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { FEED_ARTICLE_ATTR } from '@/layers/shared/model';
import { Feed } from '@/layers/shared/ui';
import type { PendingPost } from '@/layers/entities/room';
import type { ConversationRow } from '../lib/row-kinds';
import { useConversation } from '../model/conversation-context';
import { forgetTimelinePosition, useTimelineScroll } from '../model/use-timeline-scroll';
import { PendingRow } from './rows/PendingRow';
import { ScrollThumb } from './ScrollThumb';

/** What a row is told about where it is being drawn. */
export interface ConversationRowContext {
  /**
   * Where this row sits in the list it was handed in.
   *
   * The host builds `rows` from its own richer row model, so this is how it
   * reads the rest of that model back — `hostRows[ctx.index]` is the same row,
   * by construction.
   */
  index: number;
  /**
   * Open this row's thread, or `undefined` when the conversation has none.
   *
   * Gated on `capabilities.threads` here rather than at every call site, so a
   * surface without threads cannot grow a reply row by accident.
   */
  onOpenThread?: (rootId: string) => void;
}

/** Draws one row of a conversation. */
export type ConversationRowRenderer = (
  row: ConversationRow,
  context: ConversationRowContext
) => ReactNode;

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
   * Two things key on it: where the reader was standing last time this scroller
   * existed, and when to open at the newest message instead.
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
 * leave for the controls around it. Every message is a named article that says
 * where it sits, so a screen reader can say "message 12 of 30, DorkBot" rather
 * than reading the history out as one wall of text.
 *
 * Only the rows on screen exist in the DOM. Page Down at the edge of that
 * window would otherwise dead-end with the key swallowed and nothing rendered
 * to move to, so the feed hands the edge back (`onBeyondRendered`) and this
 * scrolls the next article into existence and lands the focus on it.
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

  // One element, two consumers: the hook needs to be TOLD when the scroller
  // comes and goes (only a callback ref hears that), and the thumb needs an
  // object it can read the geometry off during its own effects.
  const { scrollRef: attachScroller } = scroll;
  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerRef.current = el;
      attachScroller(el);
    },
    [attachScroller]
  );

  // Stable per key-space, NOT per render. `getMeasurementOptions` lists
  // `getItemKey` among its memo deps and virtual-core's `memo` compares by
  // reference, so a fresh arrow every render invalidates it every render —
  // which clears `pendingMin` and forces `getMeasurements` to rebuild every row
  // from index 0 on every scroll event and every streamed token.
  //
  // The dep MUST be `rows`, not a ref: identity has to change exactly when the
  // key space can. `setOptions` detects reorders by comparing the PREVIOUS
  // options' `getItemKey` against the next one at the `anchorTo: 'end'` edges;
  // a ref-reading callback would answer with today's keys on both sides of that
  // comparison and silently kill reorder detection.
  const getItemKey = useCallback((index: number) => rows[index]?.id ?? index, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 80,
    overscan: 5,
    // The virtualizer's key space MUST match the key React reconciles rows by
    // (`rows[index].id` in the render below). Two things break on virtual-core's
    // index default: the zero-guard in `measureElement` looks a row's last real
    // height up in `itemSizeCache` BY KEY, so after any row shift — a day divider
    // appearing, the unread rule moving — it would answer with a neighbour's
    // height; and `elementsCache` is keyed the same way, so a row that merely
    // changed position would stop being re-observed and never measure again.
    getItemKey,
    // Live measurement with a zero-guard cache fallback. Rows measure their
    // real DOM height (the ResizeObserver entry when present, else the rect) —
    // EXCEPT when the measurement comes back 0: a hidden scroll container
    // (`display: none`, e.g. an Obsidian sidebar tab switched away) measures
    // every row at 0, and letting those zeros poison the size cache collapses
    // the total height and loses the scroll position. Answering with the last
    // cached real height instead keeps the layout intact while hidden; live
    // measurement resumes naturally on re-show. (Do NOT replace this with
    // `useCachedMeasurements: true`: that flag makes the default measurer
    // *always* answer from the cache, and since nothing ever seeds the cache,
    // every row would freeze at the estimate.)
    measureElement: (element, entry, instance) => {
      const box = entry?.borderBoxSize?.[0];
      const size = box ? Math.round(box.blockSize) : element.getBoundingClientRect().height;
      if (size > 0) return size;
      const index = instance.indexFromElement(element);
      const key = instance.options.getItemKey(index);
      return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index);
    },
    // Anchor the list to its end: when rows above change height the view stays
    // put relative to the last item, and when a new row is appended while the
    // reader is pinned near the bottom the list follows it. Together with the
    // growing-last-item clamp in virtual-core 3.17, this keeps the conversation
    // pinned to the newest tokens during streaming while leaving a reader who
    // has scrolled up undisturbed. It is also what replaced the room's
    // hand-written follow, which is why `use-timeline-scroll` no longer writes
    // `scrollTop` on an arrival.
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 64,
  });

  // Where a conversation lands when you open it, decided ONCE per conversation
  // on the first render that has rows.
  //
  // A reader coming back from a thread panel — which UNMOUNTS this whole
  // timeline on a phone — belongs where they were standing, so a restored
  // position wins outright and this stands down.
  //
  // With `landOn: 'unread'` and a rule on screen, land on the rule: landing at
  // the end makes the list pinned, which marks everything seen and overwrites
  // the very cursor that drew the rule. Otherwise land on the newest row,
  // exactly as every chat surface does. (anchorTo/followOnAppend only engage
  // after the first mount.)
  const anchoredRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!landingReady || anchoredRef.current === conversationId || rows.length === 0) return;
    anchoredRef.current = conversationId;
    if (scroll.restoredPosition) return;
    const unreadIndex =
      landOn === 'unread' ? rows.findIndex((row) => row.kind === 'unread-divider') : -1;
    if (unreadIndex === -1) {
      virtualizer.scrollToEnd();
      return;
    }
    // One row of context above the rule, so the last already-seen message is
    // still on screen. Landing the rule flush at the viewport top loses the
    // "here is what you already read" edge that makes it legible.
    virtualizer.scrollToIndex(Math.max(0, unreadIndex - 1), { align: 'start' });
  }, [landingReady, conversationId, rows, virtualizer, landOn, scroll.restoredPosition]);

  // TRAP: `isAtEnd()` is vacuously TRUE on the first commit. It derives from
  // `getMaxScrollOffset()`, which returns 0 while `virtualizer.scrollElement`
  // is still null — and the scroll element is only attached by the
  // virtualizer's own layout effect, after the first render has already been
  // read. So a first-render `isAtEnd()` says "pinned to the bottom" for a
  // 500-message transcript the landing effect above just scrolled to the middle
  // of. Anything that WRITES on the strength of being pinned has to wait for a
  // commit with real geometry; `measured` is that wait.
  //
  // Declared AFTER the landing effect on purpose: layout effects run in
  // declaration order, so the re-render this schedules reads a scroll element
  // that is both attached and already scrolled.
  const [measured, setMeasured] = useState(false);
  useLayoutEffect(() => {
    setMeasured(true);
  }, []);

  const isAtEnd = virtualizer.isAtEnd();
  useEffect(() => {
    if (measured && isAtEnd) onReachedBottom?.();
  }, [measured, isAtEnd, onReachedBottom]);

  // Page Down at the edge of the rendered window. Only a few rows either side
  // of the viewport exist in the DOM, so without this a reader crossing a long
  // conversation stops dead at whatever the window happens to end on — message
  // 9 of 30 — with the key swallowed and nothing to show for it. The feed asks
  // for the next article, this scrolls it into existence, and the effect below
  // lands the focus on it once it has rendered.
  //
  // Articles are the MESSAGE rows and nothing else — the day rule and the
  // unread rule are separators between articles, and a host numbers over its
  // messages for exactly that reason — so `aria-posinset` counts them in order.
  const pendingFocusRef = useRef<number | null>(null);
  const handleBeyondRendered = useCallback(
    (direction: 'next' | 'previous', edge: HTMLElement) => {
      const position = Number(edge.getAttribute('aria-posinset'));
      const wanted = direction === 'next' ? position + 1 : position - 1;
      if (!Number.isFinite(wanted) || wanted < 1) return;
      let seen = 0;
      const rowIndex = rows.findIndex((row) => row.kind === 'message' && ++seen === wanted);
      if (rowIndex === -1) return;
      pendingFocusRef.current = wanted;
      virtualizer.scrollToIndex(rowIndex, { align: direction === 'next' ? 'end' : 'start' });
    },
    [rows, virtualizer]
  );

  // Focus what the scroll above went to fetch, on the first render that has it.
  // Runs every render rather than on a dep, because the render that finally
  // holds the row is caused by the virtualizer's own measurement rather than by
  // anything in this component's props.
  useEffect(() => {
    const wanted = pendingFocusRef.current;
    if (wanted === null) return;
    const article = scrollerRef.current?.querySelector<HTMLElement>(
      `[${FEED_ARTICLE_ATTR}][aria-posinset="${wanted}"]`
    );
    if (article === null || article === undefined) return;
    pendingFocusRef.current = null;
    article.focus();
  });

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

  // Leaving takes the memory with it when the reader is at the bottom: a
  // conversation left at its newest message opens at its newest message, and
  // remembering an offset that IS the bottom would fight the landing effect the
  // next time this mounts.
  useEffect(() => {
    return () => {
      if (scroll.isAtBottom) forgetTimelinePosition(conversationId);
    };
  }, [conversationId, scroll.isAtBottom]);

  const rowContext = useMemo(
    () => ({ onOpenThread: capabilities.threads ? onOpenThread : undefined }),
    [capabilities.threads, onOpenThread]
  );

  if (loading !== undefined) return <>{loading}</>;
  if (empty !== undefined && rows.length === 0 && pendingRows.length === 0) return <>{empty}</>;

  return (
    <div data-testid={testId} className={cn('relative min-h-0 flex-1', className)}>
      <div
        ref={setScroller}
        onScroll={scroll.onScroll}
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
            {virtualizer.getVirtualItems().map((virtualRow) => (
              <div
                key={rows[virtualRow.index]!.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderRow(rows[virtualRow.index]!, { ...rowContext, index: virtualRow.index })}
              </div>
            ))}
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

      {/* What a reader gets INSTEAD of being taken to the bottom by somebody
          else's message. Both affordances hang off the scroller rather than the
          list, so neither can move a row. */}
      <AnimatePresence>
        {scroll.hasNewRows && !scroll.isAtBottom && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2 }}
            onClick={() => scroll.scrollToBottom({ behavior: 'smooth' })}
            data-testid="conversation-new-messages"
            className="bg-foreground text-background hover:bg-foreground/90 absolute bottom-4 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium shadow-sm transition-colors"
            role="status"
            aria-live="polite"
          >
            New messages
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!scroll.isAtBottom && rows.length > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.15 }}
            onClick={() => scroll.scrollToBottom({ behavior: 'smooth' })}
            data-testid="conversation-jump-to-latest"
            className="bg-background absolute right-4 bottom-4 rounded-full border p-2 shadow-sm transition-shadow hover:shadow-md"
            aria-label="Scroll to bottom"
          >
            <ArrowDown className="size-(--size-icon-md)" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

import {
  useEffect,
  useLayoutEffect,
  useState,
  useMemo,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { MessagePart } from '@dorkos/shared/types';
import type { ChatMessage } from '../model/use-chat-session';
import type { TextEffectConfig } from '@/layers/shared/lib';
import { getAgentDisplayName, resolveAgentVisual } from '@/layers/shared/lib';
import { FEED_ARTICLE_ATTR, useAppStore } from '@/layers/shared/model';
import { Feed } from '@/layers/shared/ui';
import { useCurrentAgent } from '@/layers/entities/agent';
import { useSessionRuntime } from '@/layers/entities/session';
import { WIDGET_FENCE_MARKER } from '@/layers/features/gen-ui';
import { DayDivider, UnreadDivider } from '@/layers/features/conversation';
import { SessionMessage, StagedContextNote } from './message';
import type { InteractiveToolHandle } from './message';
import { buildListRows } from '../lib/build-list-rows';
import type { ListRow } from '../lib/build-list-rows';
import { resolveMessageAuthor } from '../lib/resolve-message-author';
import type { MessageAuthorContext } from '../lib/resolve-message-author';
import { useUnreadCursor } from '../model/view/use-unread-cursor';
import { useStreamingAnnouncer } from '../model/stream/use-streaming-announcer';
import { useApprovalAnnouncer } from '../model/stream/use-approval-announcer';
import { ScrollThumb } from './ScrollThumb';

/**
 * What the transcript is called when a screen reader lands in it.
 *
 * Generic on purpose: a session's chat has no title of its own on screen, and
 * inventing one would name the feed after something the reader cannot see.
 */
export const TRANSCRIPT_FEED_LABEL = 'Conversation';

/**
 * Stable empty part list. A fresh `[]` per render would re-run the approval
 * announcer's effect on every render of a message that has no parts.
 */
const EMPTY_PARTS: MessagePart[] = [];

/**
 * How close to the bottom (px) still counts as "pinned". Within this band the
 * list follows new messages and streaming tokens, and the jump-to-latest
 * affordance stays hidden. Matches the near-bottom band the retired
 * use-stick-to-bottom dependency used, so the pin/affordance feel is unchanged.
 */
const NEAR_BOTTOM_THRESHOLD_PX = 70;

/**
 * Index of the newest message whose content carries a `dorkos-ui` widget fence,
 * or `-1` when none does. Drives the FENCE-based supersede rule (DOR-302): a
 * widget goes stale only when a NEWER fence-bearing message exists — trailing
 * agent text or a follow-up exchange never freezes a live board. A cheap marker
 * scan is enough; parsing is owned by the fence renderer.
 */
export function findLastWidgetFenceIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].content.includes(WIDGET_FENCE_MARKER)) return i;
  }
  return -1;
}

export interface ScrollState {
  isAtBottom: boolean;
}

export interface MessageListHandle {
  scrollToBottom: () => void;
}

interface MessageListProps {
  messages: ChatMessage[];
  sessionId: string;
  isTextStreaming?: boolean;
  onScrollStateChange?: (state: ScrollState) => void;
  activeToolCallId?: string | null;
  onToolRef?: (handle: InteractiveToolHandle | null) => void;
  focusedOptionIndex?: number;
  onToolDecided?: (toolCallId: string, answers?: Record<string, string>) => void;
  onRetry?: () => void;
  /** Tool call ID being handled in the input zone, or null. */
  inputZoneToolCallId?: string | null;
  /** Text animation effect for streaming text. When undefined, StreamingText uses its default. */
  textEffect?: TextEffectConfig;
  /** Display name of the session's runtime (e.g. "Claude"), for auth-error copy. */
  runtimeLabel?: string;
}

/**
 * The session's transcript: a virtualized list of messages, day boundaries and
 * the rule marking where you left off.
 *
 * **It is a feed** (WAI-ARIA `role="feed"`), which is what makes crossing a long
 * conversation bearable without a mouse: Page Down and Page Up step message to
 * message however much each one carries, and Ctrl+Home / Ctrl+End leave for the
 * controls around it. Every message is a named article that says where it sits,
 * so a screen reader can say "message 12 of 30, DorkBot" rather than reading the
 * transcript out as one wall of text. `Feed` explains why the mechanics live in
 * `shared` rather than here.
 *
 * **The browsable history and the turn in flight are different things.** History
 * is the feed: it announces what you land on and nothing on its own. The answer
 * still being written is mirrored into a small `role="log"` region so it is
 * heard as it arrives — and when the turn settles, the message becomes an
 * ordinary article and is not read out a second time
 * ({@link useStreamingAnnouncer}).
 *
 * Verified in a browser, because what Ctrl+End actually reaches is a fact about
 * the page and not about this file: Ctrl+Home lands on the panel control in the
 * header above, and Ctrl+End on the jump-to-latest affordance while it is
 * showing, else the composer. That affordance is a real control that appears
 * precisely when a reader has scrolled up — which is when Ctrl+End is pressed —
 * so it is left in the tab order rather than hidden from the way out.
 *
 * Only the rows on screen exist in the DOM, which is the one place a
 * virtualized feed differs from the room's. Page Down at the edge of that
 * window would otherwise dead-end at message 9 of 30 with the key swallowed and
 * nothing rendered to move to, so the feed hands the edge back
 * (`onBeyondRendered`) and this scrolls the next article into existence and
 * lands the focus on it. `aria-posinset`/`aria-setsize` are what tell the two
 * ends apart: the end of the window is not the end of the history.
 */
export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  {
    messages,
    sessionId,
    isTextStreaming,
    onScrollStateChange,
    activeToolCallId,
    onToolRef,
    focusedOptionIndex,
    onToolDecided,
    onRetry,
    inputZoneToolCallId,
    textEffect,
    runtimeLabel,
  },
  ref
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const lastWidgetFenceIndex = useMemo(() => findLastWidgetFenceIndex(messages), [messages]);

  // Author identity for the gutter (spec `multi-participant-message-list`, D3):
  // the agent registered at the working directory, else the session's runtime
  // brand. Both reads are shared caches other surfaces already hold — the
  // composer resolves the same agent for its "Message <name>…" placeholder — so
  // this costs a cache hit, not a fetch.
  //
  // LIMITATION: this resolves the agent at the app-wide selected directory, not
  // the session's own `cwd`, so a session rendered while another directory is
  // selected would name that directory's agent. There is no cheap fix: the only
  // client-side source of a session's `cwd` is the session-list
  // cache, which is itself keyed by the selected directory (exact-cwd membership,
  // DOR-203) — a session outside it simply is not there, so reading `session.cwd`
  // would return the selected directory again or nothing at all. Closing this
  // needs a per-session read, which phase 1 deliberately does not add.
  // `useSessionRuntime` carries the identical limitation by the same mechanism.
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const runtime = useSessionRuntime(sessionId);
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const authorContext = useMemo<MessageAuthorContext>(
    () => ({
      agent: currentAgent
        ? {
            id: currentAgent.id,
            displayName: getAgentDisplayName(currentAgent),
            ...resolveAgentVisual(currentAgent),
          }
        : null,
      runtime,
    }),
    [currentAgent, runtime]
  );

  // The turn happening NOW, mirrored into a live region below. The feed itself
  // announces nothing — that is what a feed is — so this is the only thing that
  // says an answer is arriving without the reader having to go and look.
  const newest = messages[messages.length - 1];
  const streamingTail = newest?.role === 'assistant' ? newest : undefined;
  const announcement = useStreamingAnnouncer({
    messageId: streamingTail?.id,
    text: streamingTail?.content ?? '',
    isStreaming: streamingTail !== undefined && isTextStreaming === true,
  });

  // A permission request getting its answer, said out loud. It is announced
  // from here rather than from the card because answering the card unmounts it.
  const approvalAnnouncement = useApprovalAnnouncer(newest?.parts ?? EMPTY_PARTS, sessionId);

  const { lastSeenMessageId, unreadFromStart, markSeen, isHydrated } = useUnreadCursor(
    sessionId,
    messages
  );

  // Rows, not messages, are what the list virtualizes: dividers are real rows so
  // their heights participate in measurement. Memoized on the messages array,
  // exactly as the role-based grouping it replaces was — so `now` (which only
  // phrases day labels as Today/Yesterday) is re-read whenever the list changes.
  // Accepted consequence: a tab left idle across midnight keeps yesterday's
  // "Today" chip until the next message lands. Re-labelling a silent transcript
  // is not worth a timer.
  const rows = useMemo(
    () =>
      buildListRows(messages, {
        resolveAuthor: (message) => resolveMessageAuthor(message, authorContext),
        now: Date.now(),
        lastSeenMessageId,
        unreadFromStart,
      }),
    [messages, authorContext, lastSeenMessageId, unreadFromStart]
  );

  useEffect(() => {
    if (historyCount === null && messages.length > 0) {
      setHistoryCount(messages.length);
    }
  }, [messages.length, historyCount]);

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
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 5,
    // The virtualizer's key space MUST match the key React reconciles rows by
    // (`rows[index].key` in the render below). Two things break on virtual-core's
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
    // the total height and loses the scroll position — the bug the retired
    // IntersectionObserver hack papered over. Answering with the last cached
    // real height instead keeps the layout intact while hidden; live
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
    // Anchor the list to its end: when messages above change height the view
    // stays put relative to the last item, and when a new message is appended
    // while the reader is pinned near the bottom the list follows it. Together
    // with the growing-last-item clamp in virtual-core 3.17, this keeps the
    // conversation pinned to the newest tokens during streaming while leaving a
    // reader who has scrolled up undisturbed. Replaces use-stick-to-bottom.
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: NEAR_BOTTOM_THRESHOLD_PX,
  });

  // Where a conversation lands when you open it, decided ONCE per session on the
  // first render that has rows.
  //
  // With an unread rule, land on the rule — otherwise the reader never sees it:
  // landing at the end makes the list pinned, which marks everything seen and
  // overwrites the very cursor that drew the rule. Without one, land on the
  // newest message, exactly as before, so opening or switching a conversation
  // shows its latest turn without a jump. (anchorTo/followOnAppend only engage
  // after the first mount.)
  //
  // The ref holds the session already anchored, so streaming messages — which
  // change `rows` constantly — can never yank a reader who has scrolled away.
  //
  // And it waits for the cursor to come back from the server (`isHydrated`).
  // The read is a round trip now, not a synchronous storage read: anchoring on
  // the first render with rows would land every conversation at the end, and
  // being at the end is what marks it read — so the rule would be consumed a
  // frame before it could be drawn.
  const anchoredSessionRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!isHydrated || anchoredSessionRef.current === sessionId || rows.length === 0) return;
    anchoredSessionRef.current = sessionId;
    const unreadIndex = rows.findIndex((row) => row.kind === 'unread-divider');
    if (unreadIndex === -1) {
      virtualizer.scrollToEnd();
      return;
    }
    // One row of context above the rule, so the last already-seen message is
    // still on screen. Landing the rule flush at the viewport top loses the
    // "here is what you already read" edge that makes it legible.
    virtualizer.scrollToIndex(Math.max(0, unreadIndex - 1), { align: 'start' });
  }, [isHydrated, sessionId, rows, virtualizer]);

  // TRAP: `isAtEnd()` is vacuously TRUE on the first commit. It derives from
  // `getMaxScrollOffset()`, which returns 0 while `virtualizer.scrollElement`
  // is still null — and the scroll element is only attached by the
  // virtualizer's own layout effect, after the first render has already been
  // read. So a first-render `isAtEnd()` says "pinned to the bottom" for a
  // 500-message transcript the anchoring effect above just scrolled to the
  // middle of. Anything that WRITES on the strength of being pinned has to wait
  // for a commit with real geometry; `measured` is that wait.
  //
  // Declared AFTER the anchoring effect on purpose: layout effects run in
  // declaration order, so the re-render this schedules reads a scroll element
  // that is both attached and already scrolled.
  const [measured, setMeasured] = useState(false);
  useLayoutEffect(() => {
    setMeasured(true);
  }, []);

  const scrollToBottom = useCallback(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  // Page Down at the edge of the rendered window. Only a few messages either
  // side of the viewport exist in the DOM, so without this a reader crossing a
  // long conversation stops dead at whatever the window happens to end on —
  // message 9 of 30 — with the key swallowed and nothing to show for it. The
  // feed asks for the next article, this scrolls it into existence, and the
  // effect below lands the focus on it once it has rendered.
  const pendingFocusRef = useRef<number | null>(null);
  const handleBeyondRendered = useCallback(
    (direction: 'next' | 'previous', edge: HTMLElement) => {
      const position = Number(edge.getAttribute('aria-posinset'));
      const wanted = direction === 'next' ? position + 1 : position - 1;
      const rowIndex = rows.findIndex(
        (row) => row.kind === 'message' && row.messageIndex === wanted - 1
      );
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
    const article = scrollRef.current?.querySelector<HTMLElement>(
      `[${FEED_ARTICLE_ATTR}][aria-posinset="${wanted}"]`
    );
    if (article === null || article === undefined) return;
    pendingFocusRef.current = null;
    article.focus();
  });

  // The virtualizer re-renders this component on scroll, so these reads are
  // fresh each render. `isAtEnd()` honors the near-bottom threshold above.
  const isAtBottom = virtualizer.isAtEnd();

  // Sync scroll state to onScrollStateChange for useScrollOverlay. Fires only
  // when the pinned state flips. Deliberately NOT gated on `measured`: this
  // drives the jump-to-latest affordance, and starting it at "not pinned" would
  // flash the button for a frame on every mount.
  useEffect(() => {
    onScrollStateChange?.({ isAtBottom });
  }, [isAtBottom, onScrollStateChange]);

  // Reading at the bottom means everything on screen counts as seen. `markSeen`
  // re-identifies whenever the transcript grows, so this also fires as new
  // messages land while pinned — and once more when the stored cursor arrives,
  // since it does nothing until it knows what is already recorded.
  //
  // `measured` skips the first commit, whose `isAtBottom` is the vacuous
  // first-render `true` documented above. Without it, opening a session with
  // unread messages consumes its own unread rule before the reader sees it.
  useEffect(() => {
    if (measured && isAtBottom) markSeen();
  }, [measured, isAtBottom, markSeen]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom,
    }),
    [scrollToBottom]
  );

  /**
   * Render one row by kind.
   *
   * Every message-position rule reads `row.messageIndex` — the index into the
   * ORIGINAL messages array — never the virtual row index, which dividers shift.
   * Using the row index here would freeze live widgets and animate history.
   */
  function renderRow(row: ListRow) {
    if (row.kind === 'day-divider') return <DayDivider label={row.label} />;
    if (row.kind === 'unread-divider') return <UnreadDivider />;

    const { message, messageIndex } = row;

    // A staged-context note is not a turn: it renders as a quiet standalone row,
    // never a message bubble with an avatar and grouping. Branch before
    // SessionMessage so none of that chrome applies to it.
    if (message._stagedContext) {
      return <StagedContextNote content={message.content} />;
    }

    const isLastAssistant = messageIndex === messages.length - 1 && message.role === 'assistant';
    // Fence-based supersede (DOR-302): a widget in this message is stale only
    // when a NEWER fence-bearing message exists. Fence-less messages get `true`
    // vacuously (they render no widget).
    const isLatestWidgetMessage =
      lastWidgetFenceIndex === -1 || messageIndex >= lastWidgetFenceIndex;

    return (
      <SessionMessage
        message={message}
        grouping={row.grouping}
        author={row.author}
        sessionId={sessionId}
        isNew={historyCount !== null && messageIndex >= historyCount}
        isStreaming={isLastAssistant && !!isTextStreaming}
        isLatestWidgetMessage={isLatestWidgetMessage}
        activeToolCallId={activeToolCallId}
        onToolRef={onToolRef}
        focusedOptionIndex={focusedOptionIndex}
        onToolDecided={onToolDecided}
        onRetry={onRetry}
        inputZoneToolCallId={inputZoneToolCallId}
        textEffect={textEffect}
        runtimeLabel={runtimeLabel}
        // Counted over the messages themselves, which is exactly the set of
        // articles this feed holds: the day and unread rules are separators
        // between articles, so numbering them would promise stops Page Down
        // never makes.
        feedPosition={{ index: messageIndex + 1, total: messages.length }}
      />
    );
  }

  return (
    <div data-testid="message-list" className="relative h-full">
      <div
        ref={scrollRef}
        className="chat-scroll-area h-full scrollbar-none overflow-y-auto pt-12"
        style={{ overflowAnchor: 'none' }}
      >
        <Feed
          label={TRANSCRIPT_FEED_LABEL}
          data-testid="transcript-feed"
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
                key={rows[virtualRow.index].key}
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
                {renderRow(rows[virtualRow.index])}
              </div>
            ))}
          </div>
        </Feed>
      </div>
      {/*
        The turn happening now, said out loud as it arrives — sentence by
        sentence, never the whole answer again (see `useStreamingAnnouncer`).
        Rendered ALWAYS, and emptied a few seconds after it speaks: a live
        region added to the page with words already in it is read out whole by
        most screen readers, so one left holding the last sentence would say it
        again on the next mount. Clearing is itself silent.
      */}
      <div
        role="log"
        aria-live="polite"
        aria-atomic="false"
        data-testid="transcript-announcer"
        className="sr-only"
      >
        {announcement}
      </div>
      {/*
        The answer to a permission request, confirmed out loud. Polite, not
        assertive: it reports something the reader just did, so it waits its
        turn rather than cutting in. Emptied after it speaks, for the same
        reason the log above is.
      */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="approval-announcer"
        className="sr-only"
      >
        {approvalAnnouncement}
      </div>
      <ScrollThumb scrollRef={scrollRef} />
    </div>
  );
});

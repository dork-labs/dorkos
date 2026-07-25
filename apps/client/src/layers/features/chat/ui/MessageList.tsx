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
import type { ChatMessage } from '../model/use-chat-session';
import type { TextEffectConfig } from '@/layers/shared/lib';
import { getAgentDisplayName, resolveAgentVisual } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useCurrentAgent } from '@/layers/entities/agent';
import { useSessionRuntime } from '@/layers/entities/session';
import { WIDGET_FENCE_MARKER } from '@/layers/features/gen-ui';
import { MessageItem, DayDivider, UnreadDivider } from './message';
import type { InteractiveToolHandle } from './message';
import { buildListRows } from '../lib/build-list-rows';
import type { ListRow } from '../lib/build-list-rows';
import { resolveMessageAuthor } from '../lib/resolve-message-author';
import type { MessageAuthorContext } from '../lib/resolve-message-author';
import { useUnreadCursor } from '../model/view/use-unread-cursor';
import { ScrollThumb } from './ScrollThumb';

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
  // client-side source of a session's `cwd` is the `['sessions', cwd]` list
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

  const newestMessageId = messages[messages.length - 1]?.id;
  const { lastSeenMessageId, markSeen } = useUnreadCursor(sessionId, newestMessageId);

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
      }),
    [messages, authorContext, lastSeenMessageId]
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
  const anchoredSessionRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (anchoredSessionRef.current === sessionId || rows.length === 0) return;
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
  }, [sessionId, rows, virtualizer]);

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
  // re-identifies whenever the newest message changes, so this also fires as new
  // messages land while pinned.
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
    const isLastAssistant = messageIndex === messages.length - 1 && message.role === 'assistant';
    // Fence-based supersede (DOR-302): a widget in this message is stale only
    // when a NEWER fence-bearing message exists. Fence-less messages get `true`
    // vacuously (they render no widget).
    const isLatestWidgetMessage =
      lastWidgetFenceIndex === -1 || messageIndex >= lastWidgetFenceIndex;

    return (
      <MessageItem
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
      />
    );
  }

  return (
    <div data-testid="message-list" className="relative h-full">
      <div
        ref={scrollRef}
        className="chat-scroll-area h-full scrollbar-none overflow-y-auto px-3 pt-12"
        style={{ overflowAnchor: 'none' }}
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
      </div>
      <ScrollThumb scrollRef={scrollRef} />
    </div>
  );
});

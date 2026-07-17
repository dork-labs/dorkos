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
import type { ChatMessage, MessageGrouping } from '../model/use-chat-session';
import type { TextEffectConfig } from '@/layers/shared/lib';
import { WIDGET_FENCE_MARKER } from '@/layers/features/gen-ui';
import { MessageItem } from './message';
import type { InteractiveToolHandle } from './message';
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

/** Computes positional grouping metadata for consecutive same-role messages. */
export function computeGrouping(messages: ChatMessage[]): MessageGrouping[] {
  let groupIndex = 0;
  return messages.map((msg, i) => {
    const prevRole = i > 0 ? messages[i - 1].role : null;
    const nextRole = i < messages.length - 1 ? messages[i + 1].role : null;
    const isFirst = prevRole !== msg.role;
    const isLast = nextRole !== msg.role;

    if (isFirst && i > 0) groupIndex++;

    let position: MessageGrouping['position'];
    if (isFirst && isLast) position = 'only';
    else if (isFirst) position = 'first';
    else if (isLast) position = 'last';
    else position = 'middle';

    return { position, groupIndex };
  });
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
  },
  ref
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const groupings = useMemo(() => computeGrouping(messages), [messages]);
  const lastWidgetFenceIndex = useMemo(() => findLastWidgetFenceIndex(messages), [messages]);

  useEffect(() => {
    if (historyCount === null && messages.length > 0) {
      setHistoryCount(messages.length);
    }
  }, [messages.length, historyCount]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 5,
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

  // Land on the newest message on first paint and whenever the session changes,
  // so opening or switching a conversation shows its latest turn without a jump.
  // (anchorTo/followOnAppend only engage after the first mount.) The virtualizer
  // is a stable instance, so `sessionId` is what actually re-anchors this.
  useLayoutEffect(() => {
    virtualizer.scrollToEnd();
  }, [sessionId, virtualizer]);

  const scrollToBottom = useCallback(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  // The virtualizer re-renders this component on scroll, so these reads are
  // fresh each render. `isAtEnd()` honors the near-bottom threshold above.
  const isAtBottom = virtualizer.isAtEnd();

  // Sync scroll state to onScrollStateChange for useScrollOverlay. Fires only
  // when the pinned state flips.
  useEffect(() => {
    onScrollStateChange?.({ isAtBottom });
  }, [isAtBottom, onScrollStateChange]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom,
    }),
    [scrollToBottom]
  );

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
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const msg = messages[virtualRow.index];
            const isNew = historyCount !== null && virtualRow.index >= historyCount;
            const isLastAssistant =
              virtualRow.index === messages.length - 1 && msg.role === 'assistant';
            const isStreaming = isLastAssistant && !!isTextStreaming;
            // Fence-based supersede (DOR-302): a widget in this message is
            // stale only when a NEWER fence-bearing message exists. Fence-less
            // messages get `true` vacuously (they render no widget).
            const isLatestWidgetMessage =
              lastWidgetFenceIndex === -1 || virtualRow.index >= lastWidgetFenceIndex;

            return (
              <div
                key={virtualRow.key}
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
                <MessageItem
                  message={msg}
                  grouping={groupings[virtualRow.index]}
                  sessionId={sessionId}
                  isNew={isNew}
                  isStreaming={isStreaming}
                  isLatestWidgetMessage={isLatestWidgetMessage}
                  activeToolCallId={activeToolCallId}
                  onToolRef={onToolRef}
                  focusedOptionIndex={focusedOptionIndex}
                  onToolDecided={onToolDecided}
                  onRetry={onRetry}
                  inputZoneToolCallId={inputZoneToolCallId}
                  textEffect={textEffect}
                />
              </div>
            );
          })}
        </div>
      </div>
      <ScrollThumb scrollRef={scrollRef} />
    </div>
  );
});

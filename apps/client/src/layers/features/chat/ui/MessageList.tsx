import { useEffect, useState, useMemo, useImperativeHandle, forwardRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStickToBottom } from 'use-stick-to-bottom';
import type { ChatMessage, MessageGrouping } from '../model/use-chat-session';
import type { TextEffectConfig } from '@/layers/shared/lib';
import { WIDGET_FENCE_MARKER } from '@/layers/features/gen-ui';
import { MessageItem } from './message';
import type { InteractiveToolHandle } from './message';
import { ScrollThumb } from './ScrollThumb';

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
  distanceFromBottom: number;
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
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const groupings = useMemo(() => computeGrouping(messages), [messages]);
  const lastWidgetFenceIndex = useMemo(() => findLastWidgetFenceIndex(messages), [messages]);

  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    resize: 'smooth',
    initial: 'instant',
  });

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
    // Reuse the last real height for an item instead of re-measuring it to zero
    // when the scroll container is hidden (`display: none` — e.g. an Obsidian
    // sidebar tab switched away). virtual-core 3.17 honors this inside its
    // default `measureElement`, so scroll position survives a hide/re-show
    // without the bespoke IntersectionObserver workaround this replaces. NOTE:
    // this only takes effect with the library's default measurer — a custom
    // `measureElement` would bypass the cache.
    useCachedMeasurements: true,
  });

  // Sync isAtBottom state to the onScrollStateChange callback for useScrollOverlay compatibility.
  useEffect(() => {
    onScrollStateChange?.({
      isAtBottom,
      distanceFromBottom: isAtBottom ? 0 : 200,
    });
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
          ref={contentRef}
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

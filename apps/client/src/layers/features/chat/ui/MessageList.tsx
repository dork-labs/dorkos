import {
  useEffect,
  useState,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStickToBottom } from 'use-stick-to-bottom';
import type { ChatMessage, MessageGrouping } from '../model/use-chat-session';
import type { PermissionMode } from '@dorkos/shared/types';
import type { TextEffectConfig } from '@/layers/shared/lib';
import { MessageItem } from './message';
import type { InteractiveToolHandle } from './message';
import { InferenceIndicator } from './InferenceIndicator';
import { ScrollThumb } from './ScrollThumb';

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
  status?: 'idle' | 'streaming' | 'error';
  isTextStreaming?: boolean;
  onScrollStateChange?: (state: ScrollState) => void;
  streamStartTime?: number | null;
  estimatedTokens?: number;
  permissionMode?: PermissionMode;
  isWaitingForUser?: boolean;
  waitingType?: 'approval' | 'question';
  isRateLimited?: boolean;
  rateLimitRetryAfter?: number | null;
  activeToolCallId?: string | null;
  onToolRef?: (handle: InteractiveToolHandle | null) => void;
  focusedOptionIndex?: number;
  onToolDecided?: (toolCallId: string) => void;
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
    status,
    isTextStreaming,
    onScrollStateChange,
    streamStartTime,
    estimatedTokens,
    permissionMode,
    isWaitingForUser,
    waitingType,
    isRateLimited,
    rateLimitRetryAfter,
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

  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    resize: 'smooth',
    initial: 'smooth',
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
    measureElement: (el) => el?.getBoundingClientRect().height ?? 80,
  });

  // Sync isAtBottom state to the onScrollStateChange callback for useScrollOverlay compatibility.
  useEffect(() => {
    onScrollStateChange?.({
      isAtBottom,
      distanceFromBottom: isAtBottom ? 0 : 200,
    });
  }, [isAtBottom, onScrollStateChange]);

  // When the scroll container becomes visible again (e.g. switching Obsidian
  // sidebar tabs), the virtualizer loses its scroll position. Detect
  // visibility changes and scroll to bottom when re-shown.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || messages.length === 0) return;
    let wasHidden = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          wasHidden = true;
        } else if (wasHidden) {
          wasHidden = false;
          // Small delay so the virtualizer can re-measure after layout
          requestAnimationFrame(() => {
            scrollToBottom();
          });
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [messages.length, scrollToBottom]);

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
        className="chat-scroll-area hide-scrollbar h-full overflow-y-auto pt-12"
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
          {/* Inference indicator — positioned after all virtualizer items */}
          <div
            style={{ position: 'absolute', top: virtualizer.getTotalSize(), left: 0, width: '100%' }}
          >
            <InferenceIndicator
              status={status ?? 'idle'}
              streamStartTime={streamStartTime ?? null}
              estimatedTokens={estimatedTokens ?? 0}
              permissionMode={permissionMode}
              isWaitingForUser={isWaitingForUser}
              waitingType={waitingType}
              isRateLimited={isRateLimited}
              rateLimitRetryAfter={rateLimitRetryAfter}
            />
          </div>
        </div>
      </div>
      <ScrollThumb scrollRef={scrollRef} />
    </div>
  );
});

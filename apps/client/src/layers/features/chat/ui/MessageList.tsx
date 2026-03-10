import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage, MessageGrouping } from '../model/use-chat-session';
import type { PermissionMode } from '@dorkos/shared/types';
import { MessageItem } from './message';
import type { InteractiveToolHandle } from './message';
import { InferenceIndicator } from './InferenceIndicator';

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
  activeToolCallId?: string | null;
  onToolRef?: (handle: InteractiveToolHandle | null) => void;
  focusedOptionIndex?: number;
  onToolDecided?: (toolCallId: string) => void;
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
    activeToolCallId,
    onToolRef,
    focusedOptionIndex,
    onToolDecided,
  },
  ref
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const isAtBottomRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const rafIdRef = useRef<number>(0);
  const groupings = useMemo(() => computeGrouping(messages), [messages]);

  useEffect(() => {
    if (historyCount === null && messages.length > 0) {
      setHistoryCount(messages.length);
    }
  }, [messages.length, historyCount]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 80,
  });

  const isTouchActiveRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const clearScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track scroll position and report to parent
  const handleScroll = useCallback(() => {
    const container = parentRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const isAtBottom = distanceFromBottom < 200;

    // Only disengage auto-scroll when the user has explicitly scrolled up.
    // Layout reflow events from TanStack Virtual measurement also fire the
    // scroll event — gating behind isUserScrollingRef prevents these from
    // spuriously flipping the flag.
    const newValue = isAtBottom || isUserScrollingRef.current ? isAtBottom : isAtBottomRef.current;
    const changed = isAtBottomRef.current !== newValue;
    isAtBottomRef.current = newValue;
    if (changed) {
      onScrollStateChange?.({ isAtBottom: newValue, distanceFromBottom });
    }
  }, [onScrollStateChange]);

  useEffect(() => {
    const container = parentRef.current;
    if (!container) return;
    const onTouchStart = () => {
      isTouchActiveRef.current = true;
      // Mark user scroll intent on touch
      isUserScrollingRef.current = true;
      if (clearScrollIntentTimerRef.current) clearTimeout(clearScrollIntentTimerRef.current);
      clearScrollIntentTimerRef.current = setTimeout(() => {
        isUserScrollingRef.current = false;
      }, 150);
    };
    const onTouchEnd = () => {
      isTouchActiveRef.current = false;
    };
    const onWheel = () => {
      // wheel only fires for user-initiated scroll, never for programmatic scrollTop assignment
      isUserScrollingRef.current = true;
      if (clearScrollIntentTimerRef.current) clearTimeout(clearScrollIntentTimerRef.current);
      clearScrollIntentTimerRef.current = setTimeout(() => {
        isUserScrollingRef.current = false;
      }, 150);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });
    container.addEventListener('wheel', onWheel, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('wheel', onWheel);
      if (clearScrollIntentTimerRef.current) clearTimeout(clearScrollIntentTimerRef.current);
    };
  }, [handleScroll]);

  // When the scroll container becomes visible again (e.g. switching Obsidian
  // sidebar tabs), the virtualizer loses its scroll position. Detect
  // visibility changes and scroll to bottom when re-shown.
  useEffect(() => {
    const container = parentRef.current;
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
            const scrollEl = parentRef.current;
            if (scrollEl) {
              scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
            }
          });
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [messages.length]);

  // Auto-scroll via ResizeObserver: fires on any content height change
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    const observer = new ResizeObserver(() => {
      if (isAtBottomRef.current && !isTouchActiveRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        // queueMicrotask lets the virtualizer finish measurement before the RAF
        // fires, reducing the window where scrollHeight fluctuates mid-scroll.
        queueMicrotask(() => {
          rafIdRef.current = requestAnimationFrame(() => {
            const scrollEl = parentRef.current;
            if (scrollEl) {
              scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
            }
          });
        });
      }
    });

    observer.observe(contentEl);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  // Fallback: scroll on new message addition (ResizeObserver may not fire synchronously)
  useEffect(() => {
    if (messages.length > 0 && isAtBottomRef.current && !isTouchActiveRef.current) {
      requestAnimationFrame(() => {
        const scrollEl = parentRef.current;
        if (scrollEl) {
          scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
        }
      });
    }
  }, [messages.length]);

  const scrollToBottom = useCallback(() => {
    const scrollEl = parentRef.current;
    if (scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom,
    }),
    [scrollToBottom]
  );

  return (
    <div ref={parentRef} data-testid="message-list" className="chat-scroll-area h-full overflow-y-auto pt-12">
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
              />
            </div>
          );
        })}
        {/* Inference status indicator */}
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
          />
        </div>
      </div>
    </div>
  );
});

import { useRef, useEffect, useState, useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage, MessageGrouping } from '../../hooks/use-chat-session';
import type { PermissionMode } from '@lifeos/shared/types';
import { MessageItem } from './MessageItem';
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
  onScrollStateChange?: (state: ScrollState) => void;
  streamStartTime?: number | null;
  estimatedTokens?: number;
  permissionMode?: PermissionMode;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList({ messages, sessionId, status, onScrollStateChange, streamStartTime, estimatedTokens, permissionMode }, ref) {
    const parentRef = useRef<HTMLDivElement>(null);
    const [historyCount, setHistoryCount] = useState<number | null>(null);
    const isAtBottomRef = useRef(true);
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

    // Track scroll position and report to parent
    const handleScroll = useCallback(() => {
      const container = parentRef.current;
      if (!container) return;
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const isAtBottom = distanceFromBottom < 200;
      const changed = isAtBottomRef.current !== isAtBottom;
      isAtBottomRef.current = isAtBottom;
      if (changed) {
        onScrollStateChange?.({ isAtBottom, distanceFromBottom });
      }
    }, [onScrollStateChange]);

    useEffect(() => {
      const container = parentRef.current;
      if (!container) return;
      const onTouchStart = () => { isTouchActiveRef.current = true; };
      const onTouchEnd = () => { isTouchActiveRef.current = false; };
      container.addEventListener('scroll', handleScroll, { passive: true });
      container.addEventListener('touchstart', onTouchStart, { passive: true });
      container.addEventListener('touchend', onTouchEnd, { passive: true });
      container.addEventListener('touchcancel', onTouchEnd, { passive: true });
      return () => {
        container.removeEventListener('scroll', handleScroll);
        container.removeEventListener('touchstart', onTouchStart);
        container.removeEventListener('touchend', onTouchEnd);
        container.removeEventListener('touchcancel', onTouchEnd);
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
              virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
            });
          }
        },
        { threshold: 0.1 }
      );
      observer.observe(container);
      return () => observer.disconnect();
    }, [virtualizer, messages.length]);

    // Compute a scroll trigger that changes when messages are added or
    // when the last message's tool calls change (e.g. interactive prompts).
    const lastMsg = messages[messages.length - 1];
    const scrollTrigger = `${messages.length}:${lastMsg?.toolCalls?.length ?? 0}`;

    // Auto-scroll to bottom on new messages or tool call additions.
    // Skip during active touch to avoid cancelling native momentum scroll.
    useEffect(() => {
      if (messages.length > 0 && isAtBottomRef.current && !isTouchActiveRef.current) {
        virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
      }
    }, [scrollTrigger, virtualizer]);

    const scrollToBottom = useCallback(() => {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }, [virtualizer, messages.length]);

    useImperativeHandle(ref, () => ({
      scrollToBottom,
    }), [scrollToBottom]);

    return (
      <div ref={parentRef} className="chat-scroll-area h-full overflow-y-auto">
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
            const isStreaming = isLastAssistant && status === 'streaming';

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
                />
              </div>
            );
          })}
          {/* Inference status indicator */}
          <div style={{ position: 'absolute', top: virtualizer.getTotalSize(), left: 0, width: '100%' }}>
            <InferenceIndicator
              status={status ?? 'idle'}
              streamStartTime={streamStartTime ?? null}
              estimatedTokens={estimatedTokens ?? 0}
              permissionMode={permissionMode}
            />
          </div>
        </div>
      </div>
    );
  }
);

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage, MessageGrouping } from '../../hooks/use-chat-session';
import { MessageItem } from './MessageItem';

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

interface MessageListProps {
  messages: ChatMessage[];
  sessionId: string;
  status?: 'idle' | 'streaming' | 'error';
}

export function MessageList({ messages, sessionId, status }: MessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
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

  // Track scroll position for scroll-to-bottom button
  const handleScroll = useCallback(() => {
    const container = parentRef.current;
    if (!container) return;
    const threshold = 100;
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    setShowScrollButton(!isNearBottom);
  }, []);

  useEffect(() => {
    const container = parentRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
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

  // Auto-scroll to bottom on new messages or tool call additions
  useEffect(() => {
    if (messages.length > 0 && !showScrollButton) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }
  }, [scrollTrigger, virtualizer, showScrollButton]);

  const scrollToBottom = useCallback(() => {
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    setShowScrollButton(false);
  }, [virtualizer, messages.length]);

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto relative">
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
      </div>

      <AnimatePresence>
        {showScrollButton && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.15 }}
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background border shadow-sm p-2 hover:shadow-md transition-shadow"
            aria-label="Scroll to bottom"
          >
            <ArrowDown className="h-4 w-4" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

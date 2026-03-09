import { useState, useRef, useEffect, useCallback, type RefObject } from 'react';
import type { MessageListHandle, ScrollState } from '../ui/MessageList';

interface UseScrollOverlayReturn {
  isAtBottom: boolean;
  hasNewMessages: boolean;
  scrollToBottom: () => void;
  handleScrollStateChange: (state: ScrollState) => void;
}

/**
 * Track scroll position and detect new messages arriving while scrolled up.
 */
export function useScrollOverlay(
  messages: { length: number },
  messageListRef: RefObject<MessageListHandle | null>
): UseScrollOverlayReturn {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const prevMessageCountRef = useRef(messages.length);

  const handleScrollStateChange = useCallback((state: ScrollState) => {
    setIsAtBottom(state.isAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom();
    setIsAtBottom(true);
    setHasNewMessages(false);
  }, [messageListRef]);

  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (messages.length > prevCount && !isAtBottom) {
      setHasNewMessages(true);
    }
  }, [messages.length, isAtBottom]);

  useEffect(() => {
    if (isAtBottom) {
      setHasNewMessages(false);
    }
  }, [isAtBottom]);

  return { isAtBottom, hasNewMessages, scrollToBottom, handleScrollStateChange };
}

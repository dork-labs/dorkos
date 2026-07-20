import type { RefObject } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { useAppStore, useAgentBirthRecord } from '@/layers/shared/model';
import { MessageList } from './MessageList';
import type { MessageListHandle, ScrollState } from './MessageList';
import type { ChatMessage } from '../model/chat-types';
import type { InteractiveToolHandle } from './message';

interface ChatMessageAreaProps {
  messages: ChatMessage[];
  sessionId: string;
  isLoadingHistory: boolean;
  isTextStreaming: boolean;
  /** Whether the scroll position is at the bottom of the list. */
  isAtBottom: boolean;
  /** Whether new messages arrived while the user was scrolled up. */
  hasNewMessages: boolean;
  /** Scroll the message list to the bottom. */
  scrollToBottom: () => void;
  /** Called when the scroll position changes. */
  onScrollStateChange: (state: ScrollState) => void;
  /** Tool call ID of the currently active interactive tool. */
  activeToolCallId: string | null;
  /** Ref callback for the interactive tool imperative handle. */
  onToolRef: (handle: InteractiveToolHandle | null) => void;
  /** Index of the keyboard-focused option in question prompts. */
  focusedOptionIndex: number;
  /** Called after the user decides on a tool call (answers carry submitted, index-keyed values). */
  onToolDecided: (toolCallId: string, answers?: Record<string, string>) => void;
  /** Retry the last user message. */
  onRetry: () => void;
  /** Tool call ID rendered in the input zone (to skip in message list). */
  inputZoneToolCallId: string | null;
  /** Ref forwarded to the underlying MessageList for scroll control. */
  messageListRef: RefObject<MessageListHandle | null>;
}

/**
 * Message display region: loading state, empty state, dorkbot welcome,
 * the virtualized message list, and scroll-to-bottom overlays.
 */
export function ChatMessageArea({
  messages,
  sessionId,
  isLoadingHistory,
  isTextStreaming,
  isAtBottom,
  hasNewMessages,
  scrollToBottom,
  onScrollStateChange,
  activeToolCallId,
  onToolRef,
  focusedOptionIndex,
  onToolDecided,
  onRetry,
  inputZoneToolCallId,
  messageListRef,
}: ChatMessageAreaProps) {
  const dorkbotFirstMessage = useAppStore((s) => s.dorkbotFirstMessage);
  const setDorkbotFirstMessage = useAppStore((s) => s.setDorkbotFirstMessage);
  // When a newborn agent's auto-first-turn greeting couldn't be delivered (M4),
  // the empty session says so honestly and points the person at what to do,
  // rather than a blank screen or a dead Retry button.
  const birthRecord = useAgentBirthRecord(sessionId);
  const greetingFailed = birthRecord?.greetingFailed === true;

  return (
    <div className="relative min-h-0 flex-1">
      {isLoadingHistory ? (
        <div className="flex h-full items-center justify-center">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <div className="flex gap-1">
              <span
                className="bg-muted-foreground h-2 w-2 rounded-full"
                style={{
                  animation: 'typing-dot 1.4s ease-in-out infinite',
                  animationDelay: '0s',
                }}
              />
              <span
                className="bg-muted-foreground h-2 w-2 rounded-full"
                style={{
                  animation: 'typing-dot 1.4s ease-in-out infinite',
                  animationDelay: '0.2s',
                }}
              />
              <span
                className="bg-muted-foreground h-2 w-2 rounded-full"
                style={{
                  animation: 'typing-dot 1.4s ease-in-out infinite',
                  animationDelay: '0.4s',
                }}
              />
            </div>
            Loading conversation...
          </div>
        </div>
      ) : messages.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          {greetingFailed ? (
            <div className="text-center" data-testid="greeting-failed-empty">
              <p className="text-muted-foreground text-base">
                {birthRecord?.displayName} couldn&rsquo;t say hello just now
              </p>
              <p className="text-muted-foreground/60 mt-2 text-sm">
                Send a message to get started.
              </p>
            </div>
          ) : dorkbotFirstMessage ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <motion.div
                layoutId="dorkbot-first-message"
                className="bg-muted/50 w-full max-w-md rounded-lg border p-4"
                data-testid="dorkbot-welcome-message"
                onLayoutAnimationComplete={() => {
                  setDorkbotFirstMessage(null);
                }}
              >
                <p className="text-muted-foreground text-sm">{dorkbotFirstMessage}</p>
              </motion.div>
              <p className="text-muted-foreground/60 text-sm">Type a message below to begin</p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-muted-foreground text-base">Start a conversation</p>
              <p className="text-muted-foreground/60 mt-2 text-sm">Type a message below to begin</p>
            </div>
          )}
        </div>
      ) : (
        <MessageList
          ref={messageListRef}
          messages={messages}
          sessionId={sessionId}
          isTextStreaming={isTextStreaming}
          onScrollStateChange={onScrollStateChange}
          activeToolCallId={activeToolCallId}
          onToolRef={onToolRef}
          focusedOptionIndex={focusedOptionIndex}
          onToolDecided={onToolDecided}
          onRetry={onRetry}
          inputZoneToolCallId={inputZoneToolCallId}
        />
      )}

      <AnimatePresence>
        {hasNewMessages && !isAtBottom && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2 }}
            onClick={scrollToBottom}
            className="bg-foreground text-background hover:bg-foreground/90 absolute bottom-16 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium shadow-sm transition-colors"
            role="status"
            aria-live="polite"
          >
            New messages
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!isAtBottom && messages.length > 0 && !isLoadingHistory && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.15 }}
            onClick={scrollToBottom}
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

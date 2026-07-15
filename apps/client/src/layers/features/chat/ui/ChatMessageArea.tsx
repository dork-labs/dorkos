import type { RefObject } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { useAgentBirthRecord } from '@/layers/shared/model';
import { MessageList } from './MessageList';
import type { MessageListHandle, ScrollState } from './MessageList';
import { ChatEmptyState } from './ChatEmptyState';
import { TypingDots } from './primitives';
import type { ChatMessage } from '../model/chat-types';
import type { InteractiveToolHandle } from './message';

interface ChatMessageAreaProps {
  messages: ChatMessage[];
  sessionId: string;
  isLoadingHistory: boolean;
  /**
   * Whether the durable stream snapshot has landed for this session
   * (`streamReadyCursor !== null`). Gates the first-light waking state so a
   * newborn session revisited before it rehydrates — momentarily empty though
   * its greeting already landed — never falsely claims the agent is waking up.
   */
  hydrated: boolean;
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
  /** Display name of the session's runtime (e.g. "Claude"), for auth-error copy. */
  runtimeLabel?: string;
}

/**
 * Message display region: loading state, empty state, the virtualized message
 * list, and scroll-to-bottom overlays.
 */
export function ChatMessageArea({
  messages,
  sessionId,
  isLoadingHistory,
  hydrated,
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
  runtimeLabel,
}: ChatMessageAreaProps) {
  const birthRecord = useAgentBirthRecord(sessionId);
  // First light (M4): between the opening turn firing and the first greetable
  // content landing, a newborn session shows the agent waking up — its face,
  // its name, and the quiet dots — instead of the generic empty state. Built
  // only on the birth-store latches (`fired`/`greetingFailed`): the turn is
  // genuinely in flight, so this is honest. Gated on `hydrated` so a session
  // revisited before its snapshot lands never falsely claims "waking up" — it
  // falls back to the neutral loading/empty treatment until emptiness is real.
  // A `first-message` record is not a birth (ADR 260722-111316) — it carries the
  // user's own words into an existing agent's session, so it never shows the
  // newborn "waking up" ceremony.
  const firstLightRecord =
    birthRecord &&
    birthRecord.kind !== 'first-message' &&
    birthRecord.fired &&
    !birthRecord.greetingFailed &&
    hydrated
      ? birthRecord
      : null;

  return (
    <div className="relative min-h-0 flex-1">
      {isLoadingHistory ? (
        <div className="flex h-full items-center justify-center">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <TypingDots />
            Loading conversation...
          </div>
        </div>
      ) : messages.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <ChatEmptyState birthRecord={birthRecord} firstLightRecord={firstLightRecord} />
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
          runtimeLabel={runtimeLabel}
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

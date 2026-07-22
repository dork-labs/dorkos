import { motion } from 'motion/react';
import type { ChatMessage, MessageGrouping } from '../../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';
import { cn, getPlatform } from '@/layers/shared/lib';
import type { TextEffectConfig } from '@/layers/shared/lib';
import { messageItem } from './message-variants';
import { MessageProvider } from './MessageContext';
import { UserMessageContent } from './UserMessageContent';
import { AssistantMessageContent } from './AssistantMessageContent';
import { RunWithMenu } from './RunWithMenu';
import type { InteractiveToolHandle } from './types';

interface MessageItemProps {
  message: ChatMessage;
  grouping: MessageGrouping;
  sessionId: string;
  isNew?: boolean;
  isStreaming?: boolean;
  /**
   * Whether no NEWER fence-bearing message exists — the fence-based supersede
   * rule (DOR-302). A widget in this message goes inert only when a newer
   * message carries a widget fence; trailing agent text never freezes a board.
   * Defaults to `true` (surfaces with no list context render live widgets).
   */
  isLatestWidgetMessage?: boolean;
  /** The toolCallId of the currently active interactive tool (for keyboard shortcuts) */
  activeToolCallId?: string | null;
  /** Callback to register the active tool's imperative handle */
  onToolRef?: (handle: InteractiveToolHandle | null) => void;
  /** Index of keyboard-focused option in QuestionPrompt */
  focusedOptionIndex?: number;
  /** Called when user approves/denies a tool or answers a question (answers carry the submitted, index-keyed values) */
  onToolDecided?: (toolCallId: string, answers?: Record<string, string>) => void;
  /** Called when user clicks "Retry" on an inline error block */
  onRetry?: () => void;
  /** Tool call ID being handled in the input zone, or null. */
  inputZoneToolCallId?: string | null;
  /** Text animation effect for streaming text. When undefined, StreamingText uses its default. */
  textEffect?: TextEffectConfig;
  /**
   * Presentation mode for off-session, scripted lines (e.g. the onboarding
   * conversation): suppress the hover timestamp and the hover background so a
   * synthetic bubble reads as narration, not an interactive chat message.
   */
  presentation?: boolean;
}

/** Format a timestamp string to a short time display (HH:MM). */
function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Message item orchestrator — reads grouping, role, and store settings,
 * then delegates rendering to UserMessageContent or AssistantMessageContent.
 * Provides MessageContext to all children for prop drilling elimination.
 */
export function MessageItem({
  message,
  grouping,
  sessionId,
  isNew = false,
  isStreaming = false,
  isLatestWidgetMessage = true,
  activeToolCallId = null,
  onToolRef,
  focusedOptionIndex = -1,
  onToolDecided,
  onRetry,
  inputZoneToolCallId = null,
  textEffect,
  presentation = false,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  // Local-command output is a `user`-role message, but its content is a command
  // result (often a wide ANSI table), so it renders full-width like assistant
  // output rather than crammed into the right-aligned user bubble (DOR-126).
  const isCommandOutput = message.messageType === 'local_command_output';
  const renderAsUserBubble = isUser && !isCommandOutput;
  // "Run this with…" hangs off an actual prompt bubble — not slash commands or
  // compaction markers, which are not re-runnable prompts. Web only: it launches
  // a fresh routed session, which the embedded (Obsidian) shell — a single
  // store-bound session with no route navigation — cannot host.
  const showRunWith =
    renderAsUserBubble &&
    !getPlatform().isEmbedded &&
    message.messageType !== 'command' &&
    message.messageType !== 'compaction' &&
    message.content.trim().length > 0;
  const { showTimestamps } = useAppStore();
  const { position, groupIndex } = grouping;
  const isGroupStart = position === 'only' || position === 'first';

  const styles = messageItem({
    role: renderAsUserBubble ? 'user' : 'assistant',
    position,
  });

  return (
    <MessageProvider
      value={{
        sessionId,
        isStreaming,
        isLatestWidgetMessage,
        activeToolCallId,
        onToolRef,
        focusedOptionIndex,
        onToolDecided,
        onRetry,
        inputZoneToolCallId,
        textEffect,
      }}
    >
      <motion.div
        initial={
          isNew
            ? {
                opacity: 0,
                y: 8,
                x: renderAsUserBubble ? 12 : 0,
                scale: renderAsUserBubble ? 0.97 : 1,
              }
            : false
        }
        animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        data-testid="message-item"
        data-role={message.role}
        className={cn(styles.root(), presentation && 'hover:bg-transparent')}
      >
        {isGroupStart && groupIndex > 0 && !isUser && <div className={styles.divider()} />}
        {!presentation && message.timestamp && (
          <span
            className={cn(
              styles.timestamp(),
              showTimestamps
                ? 'text-msg-timestamp'
                : 'group-hover:text-msg-timestamp text-transparent'
            )}
          >
            {formatTime(message.timestamp)}
          </span>
        )}
        {showRunWith && (
          <RunWithMenu
            prompt={message.content}
            sessionId={sessionId}
            className="absolute top-2 -left-9 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          />
        )}
        <div className={styles.content()}>
          {isUser ? (
            <UserMessageContent message={message} />
          ) : (
            <AssistantMessageContent message={message} />
          )}
        </div>
      </motion.div>
    </MessageProvider>
  );
}

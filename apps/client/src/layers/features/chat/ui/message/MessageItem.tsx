import { useId } from 'react';
import { motion } from 'motion/react';
import type { ChatMessage, MessageGrouping } from '../../model/use-chat-session';
import { feedArticleProps, useAppStore } from '@/layers/shared/model';
import type { FeedPosition, MessageAuthor } from '@/layers/shared/model';
import { cn, getPlatform } from '@/layers/shared/lib';
import type { TextEffectConfig } from '@/layers/shared/lib';
import { messageItem, MessageAuthorAvatar } from '@/layers/features/conversation';
import { EntryRunWithMenu } from '@/layers/features/entry-actions';
import { MessageProvider } from './MessageContext';
import { UserMessageContent } from './UserMessageContent';
import { AssistantMessageContent } from './AssistantMessageContent';
import type { InteractiveToolHandle } from './types';

interface MessageItemProps {
  message: ChatMessage;
  grouping: MessageGrouping;
  /** Who this message is from — the identity the gutter renders. */
  author: MessageAuthor;
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
   * conversation): suppress the timestamp, the hover background, and the hover
   * actions so a synthetic line reads as narration, not an interactive chat
   * message.
   */
  presentation?: boolean;
  /** Display name of the session's runtime (e.g. "Claude"), for auth-error copy. */
  runtimeLabel?: string;
  /**
   * Where this message sits in the transcript's feed, when it is rendering
   * inside one.
   *
   * Omitted off a transcript — the onboarding narration and the dev showcase
   * render real message rows with no feed around them, and a position in a set
   * nothing navigates would promise a Page Down that has nowhere to go.
   */
  feedPosition?: FeedPosition;
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
 * Message item orchestrator — lays out the identity gutter and content column,
 * reads grouping and store settings, then delegates rendering to
 * UserMessageContent or AssistantMessageContent. Provides MessageContext to all
 * children for prop drilling elimination.
 *
 * **Every message row is an `article`, and every one of them is NAMED** —
 * inside the transcript's feed and outside it alike, the same decision the room
 * rows landed on (`RoomEntryRow`). The name is the author line ALREADY ON
 * SCREEN, pointed at with `aria-labelledby`, never a second sentence invented
 * for screen readers — that was the DOR-583 double-speak, and the fix for it is
 * to stop inventing rather than to stay silent. A continuation row is the one
 * exception and gets an `aria-label`: the design deliberately drops its author
 * line for a run of messages from the same person, so who and when has to be
 * said directly. The body is what the article is ABOUT
 * (`aria-describedby`), which is what the APG asks a feed's articles to point
 * at.
 *
 * `feedPosition` adds where the row sits in the set, which is what lets a
 * screen reader say "message 12 of 30, DorkBot" as Page Down crosses the
 * transcript. It is a consumer of the name, not its cause.
 */
export function MessageItem({
  message,
  grouping,
  author,
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
  runtimeLabel,
  feedPosition,
}: MessageItemProps) {
  const domId = useId();
  const headerId = `${domId}-author`;
  const contentId = `${domId}-content`;
  // A group start renders the avatar, the author's name, and the time; a
  // continuation renders none of them and hangs under the group start, with its
  // time in the gutter on hover. Derived, never passed in: the caller already
  // states the same fact in `grouping.position`, and two sources for one fact
  // can only ever drift apart.
  const showAuthorHeader = grouping.position === 'first' || grouping.position === 'only';
  const isUser = message.role === 'user';
  // Local-command output is a `user`-role message, but its content is a command
  // result (often a wide ANSI table), so it takes the assistant's lighter
  // typography rather than reading as something the human typed (DOR-126).
  const isUserPrompt = isUser && message.messageType !== 'local_command_output';
  // "Run this with…" hangs off an actual prompt — not slash commands or
  // compaction markers, which are not re-runnable prompts, and not scripted
  // narration. Web only: it launches a fresh routed session, which the embedded
  // (Obsidian) shell — a single store-bound session with no route navigation —
  // cannot host.
  const showRunWith =
    isUserPrompt &&
    !presentation &&
    !getPlatform().isEmbedded &&
    message.messageType !== 'command' &&
    message.messageType !== 'compaction' &&
    message.content.trim().length > 0;
  const { showTimestamps } = useAppStore();

  const styles = messageItem({
    role: isUserPrompt ? 'user' : 'assistant',
    position: grouping.position,
  });

  const time = message.timestamp ? formatTime(message.timestamp) : '';
  const showTime = !presentation && time.length > 0;
  // The group header's time is part of the identity line, so it always shows —
  // a header reading "DorkBot" with a blank where the time belongs looks broken.
  // `showTimestamps` governs only the per-message stamps in the continuation
  // gutter, which are the noisy ones the preference exists to quiet.
  const gutterTimeTone = showTimestamps
    ? 'text-msg-timestamp'
    : 'group-hover:text-msg-timestamp text-transparent';

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
        runtimeLabel,
      }}
    >
      <motion.div
        initial={isNew ? { opacity: 0, y: 8 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        data-testid="message-item"
        data-role={message.role}
        role="article"
        {...(showAuthorHeader
          ? { 'aria-labelledby': headerId }
          : { 'aria-label': showTime ? `${author.displayName}, ${time}` : author.displayName })}
        aria-describedby={contentId}
        {...feedArticleProps(feedPosition)}
        className={cn(
          styles.root(),
          // A row Page Down can land on has to SHOW that it was landed on.
          feedPosition && 'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
          presentation && 'hover:bg-transparent'
        )}
      >
        <div className={styles.gutter()}>
          {showAuthorHeader && <MessageAuthorAvatar author={author} />}
          {!showAuthorHeader && showTime && (
            <span className={cn(styles.avatarTimestamp(), gutterTimeTone)}>{time}</span>
          )}
        </div>
        <div className={styles.body()}>
          {showAuthorHeader && (
            <div id={headerId} className={styles.header()}>
              <span className={styles.authorName()}>{author.displayName}</span>
              {showTime && (
                <span className={cn(styles.timestamp(), 'text-msg-timestamp')}>{time}</span>
              )}
            </div>
          )}
          <div id={contentId} data-slot="message-content" className={styles.content()}>
            {isUser ? (
              <UserMessageContent message={message} />
            ) : (
              <AssistantMessageContent message={message} />
            )}
          </div>
        </div>
        {showRunWith && (
          <div className={styles.actions()}>
            <EntryRunWithMenu prompt={message.content} sessionId={sessionId} />
          </div>
        )}
      </motion.div>
    </MessageProvider>
  );
}

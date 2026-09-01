/**
 * One row of a session transcript — the shared row, wired to a session.
 *
 * It owns only what a session knows: which of its two voices this message is in,
 * what the row is called to a screen reader, what "Run this with…" would re-run,
 * and the context the body renderer's components read (`MessageProvider`).
 * Everything a row LOOKS like — the identity gutter, the group rhythm, the
 * author line, the hover capsule — is `Message.*`, which a channel draws from
 * the same code.
 *
 * **Every message row is an `article`, and every one of them is NAMED** — inside
 * the transcript's feed and outside it alike, the same decision the room's rows
 * landed on. The name is the author line ALREADY ON SCREEN, pointed at with
 * `aria-labelledby`, never a second sentence invented for screen readers — that
 * was the DOR-583 double-speak, and the fix for it is to stop inventing rather
 * than to stay silent. A continuation row is the one exception and gets an
 * `aria-label`: the design deliberately drops its author line for a run of
 * messages from the same person, so who and when has to be said directly. The
 * body is what the article is ABOUT (`aria-describedby`), which is what the APG
 * asks a feed's articles to point at.
 *
 * `feedPosition` adds where the row sits in the set, which is what lets a screen
 * reader say "message 12 of 30, DorkBot" as Page Down crosses the transcript. It
 * is a consumer of the name, not its cause.
 *
 * @module widgets/session/ui/SessionMessage
 */
import { useCallback, useId, useRef } from 'react';
import { getPlatform } from '@/layers/shared/lib';
import type { TextEffectConfig } from '@/layers/shared/lib';
import { feedArticleProps } from '@/layers/shared/model';
import type { FeedPosition, MessageAuthor } from '@/layers/shared/model';
import { Message, formatTime } from '@/layers/features/conversation';
import type { ChatMessage, MessageGrouping } from '@/layers/shared/model';
import { MessageProvider, type InteractiveToolHandle } from '@/layers/features/chat';
import { renderSessionBody } from './render-session-body';

interface SessionMessageProps {
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
  /** Display name of the session's runtime (e.g. "Claude"), for auth-error copy. */
  runtimeLabel?: string;
  /**
   * Whether this session's runtime can deliver a free-text deny reason to the
   * agent. Threaded to every `ApprovalPrompt` an assistant message renders
   * directly — see `MessageContextValue.allowsDenyReason` (DOR-825).
   */
  allowsDenyReason?: boolean;
  /**
   * Where this message sits in the transcript's feed, when it is rendering
   * inside one.
   *
   * Omitted off a transcript — the dev showcase renders real message rows with
   * no feed around them, and a position in a set nothing navigates would
   * promise a Page Down that has nowhere to go.
   */
  feedPosition?: FeedPosition;
}

/** One message in a session transcript. */
export function SessionMessage({
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
  runtimeLabel,
  allowsDenyReason,
  feedPosition,
}: SessionMessageProps) {
  const domId = useId();
  const headerId = `${domId}-author`;
  const contentId = `${domId}-content`;
  const rowRef = useRef<HTMLDivElement>(null);
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
  // compaction markers, which are not re-runnable prompts. Web only: it
  // launches a fresh routed session, which the embedded (Obsidian) shell — a
  // single store-bound session with no route navigation — cannot host.
  const showRunWith =
    isUserPrompt &&
    !getPlatform().isEmbedded &&
    message.messageType !== 'command' &&
    message.messageType !== 'compaction' &&
    message.content.trim().length > 0;

  const time = message.timestamp ? formatTime(message.timestamp) : '';
  const showTime = time.length > 0;
  // One timestamp for the whole row: the author line draws it on a group start
  // and the gutter draws it on hover for a continuation.
  const at = showTime ? message.timestamp : undefined;
  const focusRow = useCallback(() => rowRef.current?.focus(), []);

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
        allowsDenyReason,
      }}
    >
      <Message.Root
        ref={rowRef}
        role={isUserPrompt ? 'user' : 'assistant'}
        position={grouping.position}
        isNew={isNew}
        data-testid="message-item"
        data-role={message.role}
        {...(showAuthorHeader
          ? { 'aria-labelledby': headerId }
          : { 'aria-label': showTime ? `${author.displayName}, ${time}` : author.displayName })}
        aria-describedby={contentId}
        {...feedArticleProps(feedPosition)}
      >
        <Message.Gutter author={author} at={at} />
        <Message.Body>
          <Message.Author id={headerId} author={author} at={at} />
          <Message.Content id={contentId}>
            {renderSessionBody(message, { rowId: message.id, isStreaming })}
          </Message.Content>
          {showRunWith && (
            <Message.Actions runWith={{ prompt: message.content, sessionId }} onExit={focusRow} />
          )}
        </Message.Body>
      </Message.Root>
    </MessageProvider>
  );
}

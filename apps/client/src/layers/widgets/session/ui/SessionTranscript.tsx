/**
 * A session's transcript, drawn on `Conversation.Timeline`.
 *
 * What is left of `MessageList` and `ChatMessageArea` once the list itself is
 * shared: which rows a session has, who wrote them, what is being said out
 * loud, and where the reader left off. The scroller, the virtualizer, the feed,
 * the thumb and the two affordances for a reader who has scrolled away are the
 * timeline's now, and a channel gets the identical ones from the identical
 * code.
 *
 * It lives in `widgets/session` because a conversation's host is a widget: it
 * composes `features/conversation`'s timeline with `features/chat`'s model, and
 * only a widget may compose two features. The ROW it draws stayed a feature
 * export — `features/onboarding` renders real session rows for its scripted
 * narration — and `render-session-body.tsx` says why that matters.
 *
 * @module widgets/session/ui/SessionTranscript
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MessagePart } from '@dorkos/shared/types';
import type { TextEffectConfig } from '@/layers/shared/lib';
import { getAgentDisplayName, resolveAgentVisual } from '@/layers/shared/lib';
import { useAppStore, useAgentBirthRecord } from '@/layers/shared/model';
import type { ChatMessage } from '@/layers/shared/model';
import { Feed } from '@/layers/shared/ui';
import { useCurrentAgent } from '@/layers/entities/agent';
import { useSessionRuntime } from '@/layers/entities/session';
import { WIDGET_FENCE_MARKER } from '@/layers/features/gen-ui';
import {
  Conversation,
  DayDivider,
  UnreadDivider,
  useUnreadCursor,
  type ConversationRow,
  type ConversationRowRenderer,
} from '@/layers/features/conversation';
import {
  buildListRows,
  ChatEmptyState,
  resolveMessageAuthor,
  SessionMessage,
  StagedContextNote,
  TypingDots,
  useApprovalAnnouncer,
  useStreamingAnnouncer,
  type InteractiveToolHandle,
  type ListRow,
  type MessageAuthorContext,
} from '@/layers/features/chat';

/**
 * What the transcript is called when a screen reader lands in it.
 *
 * Generic on purpose: a session's chat has no title of its own on screen, and
 * inventing one would name the feed after something the reader cannot see.
 */
export const TRANSCRIPT_FEED_LABEL = 'Conversation';

/**
 * Stable empty part list. A fresh `[]` per render would re-run the approval
 * announcer's effect on every render of a message that has no parts.
 */
const EMPTY_PARTS: MessagePart[] = [];

/**
 * Index of the newest message whose content carries a `dorkos-ui` widget fence,
 * or `-1` when none does. Drives the FENCE-based supersede rule (DOR-302): a
 * widget goes stale only when a NEWER fence-bearing message exists — trailing
 * agent text or a follow-up exchange never freezes a live board. A cheap marker
 * scan is enough; parsing is owned by the fence renderer.
 *
 * @param messages - The rendered transcript, oldest first.
 */
export function findLastWidgetFenceIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.content.includes(WIDGET_FENCE_MARKER)) return i;
  }
  return -1;
}

interface SessionTranscriptProps {
  /** The rendered transcript, oldest first. */
  messages: ChatMessage[];
  /** The session on screen. */
  sessionId: string;
  /** True while the first page of history is still arriving. */
  isLoadingHistory?: boolean;
  /**
   * Whether the durable stream snapshot has landed for this session
   * (`streamReadyCursor !== null`). Gates the first-light waking state so a
   * newborn session revisited before it rehydrates — momentarily empty though
   * its greeting already landed — never falsely claims the agent is waking up.
   */
  hydrated?: boolean;
  /** True while the tail message is receiving tokens. */
  isTextStreaming?: boolean;
  /** Tool call ID of the currently active interactive tool. */
  activeToolCallId?: string | null;
  /** Ref callback for the interactive tool imperative handle. */
  onToolRef?: (handle: InteractiveToolHandle | null) => void;
  /** Index of the keyboard-focused option in question prompts. */
  focusedOptionIndex?: number;
  /** Called after the user decides on a tool call (answers carry submitted, index-keyed values). */
  onToolDecided?: (toolCallId: string, answers?: Record<string, string>) => void;
  /** Retry the last user message. */
  onRetry?: () => void;
  /** Tool call ID rendered in the input zone (to skip in the transcript). */
  inputZoneToolCallId?: string | null;
  /** Text animation effect for streaming text. */
  textEffect?: TextEffectConfig;
  /** Display name of the session's runtime (e.g. "Claude"), for auth-error copy. */
  runtimeLabel?: string;
}

/**
 * The session's transcript: messages, day boundaries and the rule marking where
 * you left off.
 *
 * **The browsable history and the turn in flight are different things.** History
 * is the feed: it announces what you land on and nothing on its own. The answer
 * still being written is mirrored into a small `role="log"` region so it is
 * heard as it arrives — and when the turn settles, the message becomes an
 * ordinary article and is not read out a second time
 * ({@link useStreamingAnnouncer}).
 *
 * @param props - The transcript and everything a row needs to be interactive.
 */
export function SessionTranscript({
  messages,
  sessionId,
  isLoadingHistory = false,
  hydrated = false,
  isTextStreaming = false,
  activeToolCallId = null,
  onToolRef,
  focusedOptionIndex = -1,
  onToolDecided,
  onRetry,
  inputZoneToolCallId = null,
  textEffect,
  runtimeLabel,
}: SessionTranscriptProps) {
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const lastWidgetFenceIndex = useMemo(() => findLastWidgetFenceIndex(messages), [messages]);
  const birthRecord = useAgentBirthRecord(sessionId);

  // Author identity for the gutter (spec `multi-participant-message-list`, D3):
  // the agent registered at the working directory, else the session's runtime
  // brand. Both reads are shared caches other surfaces already hold — the
  // composer resolves the same agent for its "Message <name>…" placeholder — so
  // this costs a cache hit, not a fetch.
  //
  // LIMITATION: this resolves the agent at the app-wide selected directory, not
  // the session's own `cwd`, so a session rendered while another directory is
  // selected would name that directory's agent. There is no cheap fix: the only
  // client-side source of a session's `cwd` is the session-list cache, which is
  // itself keyed by the selected directory (exact-cwd membership, DOR-203).
  // `useSessionRuntime` carries the identical limitation by the same mechanism.
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const runtime = useSessionRuntime(sessionId);
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const authorContext = useMemo<MessageAuthorContext>(
    () => ({
      agent: currentAgent
        ? {
            id: currentAgent.id,
            displayName: getAgentDisplayName(currentAgent),
            ...resolveAgentVisual(currentAgent),
          }
        : null,
      runtime,
    }),
    [currentAgent, runtime]
  );

  // The turn happening NOW, mirrored into a live region below. The feed itself
  // announces nothing — that is what a feed is — so this is the only thing that
  // says an answer is arriving without the reader having to go and look.
  const newest = messages[messages.length - 1];
  const streamingTail = newest?.role === 'assistant' ? newest : undefined;
  const announcement = useStreamingAnnouncer({
    messageId: streamingTail?.id,
    text: streamingTail?.content ?? '',
    isStreaming: streamingTail !== undefined && isTextStreaming,
  });

  // A permission request getting its answer, said out loud. It is announced
  // from here rather than from the card because answering the card unmounts it.
  const approvalAnnouncement = useApprovalAnnouncer(newest?.parts ?? EMPTY_PARTS, sessionId);

  const { lastSeenMessageId, unreadFromStart, markSeen, isHydrated } = useUnreadCursor(
    sessionId,
    messages
  );

  // Rows, not messages, are what the list virtualizes: dividers are real rows so
  // their heights participate in measurement. Memoized on the messages array,
  // exactly as the role-based grouping it replaces was — so `now` (which only
  // phrases day labels as Today/Yesterday) is re-read whenever the list changes.
  // Accepted consequence: a tab left idle across midnight keeps yesterday's
  // "Today" chip until the next message lands. Re-labelling a silent transcript
  // is not worth a timer.
  const listRows = useMemo(
    () =>
      buildListRows(messages, {
        resolveAuthor: (message) => resolveMessageAuthor(message, authorContext),
        now: Date.now(),
        lastSeenMessageId,
        unreadFromStart,
      }),
    [messages, authorContext, lastSeenMessageId, unreadFromStart]
  );

  const rows = useMemo<ConversationRow[]>(
    () =>
      listRows.map((row) => {
        if (row.kind === 'day-divider')
          return { kind: 'day-divider', id: row.key, label: row.label };
        if (row.kind === 'unread-divider') return { kind: 'unread-divider', id: row.key };
        return {
          kind: 'message',
          id: row.key,
          payload: row.message,
          grouping: row.grouping,
          author: row.author,
          at: row.message.timestamp,
        };
      }),
    [listRows]
  );

  useEffect(() => {
    if (historyCount === null && messages.length > 0) {
      setHistoryCount(messages.length);
    }
  }, [messages.length, historyCount]);

  /**
   * Render one row by kind.
   *
   * Every message-position rule reads `row.messageIndex` — the index into the
   * ORIGINAL messages array — never the row index, which dividers shift. Using
   * the row index here would freeze live widgets and animate history.
   */
  const renderRow = useCallback<ConversationRowRenderer>(
    (_row, ctx) => {
      const row: ListRow = listRows[ctx.index]!;
      if (row.kind === 'day-divider') return <DayDivider label={row.label} />;
      if (row.kind === 'unread-divider') return <UnreadDivider />;

      const { message, messageIndex } = row;

      // A staged-context note is not a turn: it renders as a quiet standalone
      // row, never a message bubble with an avatar and grouping. Branch before
      // SessionMessage so none of that chrome applies to it.
      if (message._stagedContext) return <StagedContextNote content={message.content} />;

      const isLastAssistant = messageIndex === messages.length - 1 && message.role === 'assistant';
      // Fence-based supersede (DOR-302): a widget in this message is stale only
      // when a NEWER fence-bearing message exists. Fence-less messages get
      // `true` vacuously (they render no widget).
      const isLatestWidgetMessage =
        lastWidgetFenceIndex === -1 || messageIndex >= lastWidgetFenceIndex;

      return (
        <SessionMessage
          message={message}
          grouping={row.grouping}
          author={row.author}
          sessionId={sessionId}
          isNew={historyCount !== null && messageIndex >= historyCount}
          isStreaming={isLastAssistant && isTextStreaming}
          isLatestWidgetMessage={isLatestWidgetMessage}
          activeToolCallId={activeToolCallId}
          onToolRef={onToolRef}
          focusedOptionIndex={focusedOptionIndex}
          onToolDecided={onToolDecided}
          onRetry={onRetry}
          inputZoneToolCallId={inputZoneToolCallId}
          textEffect={textEffect}
          runtimeLabel={runtimeLabel}
          // Counted over the messages themselves, which is exactly the set of
          // articles this feed holds: the day and unread rules are separators
          // between articles, so numbering them would promise stops Page Down
          // never makes.
          feedPosition={{ index: messageIndex + 1, total: messages.length }}
        />
      );
    },
    [
      listRows,
      messages.length,
      lastWidgetFenceIndex,
      sessionId,
      historyCount,
      isTextStreaming,
      activeToolCallId,
      onToolRef,
      focusedOptionIndex,
      onToolDecided,
      onRetry,
      inputZoneToolCallId,
      textEffect,
      runtimeLabel,
    ]
  );

  // First light (M4): between the opening turn firing and the first greetable
  // content landing, a newborn session shows the agent waking up — its face, its
  // name, and the quiet dots — instead of the generic empty state. Built only on
  // the birth-store latches (`fired`/`greetingFailed`): the turn is genuinely in
  // flight, so this is honest. Gated on `hydrated` so a session revisited before
  // its snapshot lands never falsely claims "waking up". A `first-message`
  // record is not a birth (ADR 260722-111316) — it carries the user's own words
  // into an existing agent's session, so it never shows the newborn ceremony.
  const firstLightRecord =
    birthRecord &&
    birthRecord.kind !== 'first-message' &&
    birthRecord.fired &&
    !birthRecord.greetingFailed &&
    hydrated
      ? birthRecord
      : null;

  return (
    <Conversation.Timeline
      conversationId={sessionId}
      label={TRANSCRIPT_FEED_LABEL}
      rows={rows}
      renderRow={renderRow}
      // A session's cursor only moves while the reader is AT the bottom, so the
      // rule survives being landed on — which is why this surface asks to land
      // on it and a room, whose cursor moves the moment the room opens, does
      // not. And it waits for the cursor to come back from the server: the read
      // is a round trip, so anchoring before it lands would put every
      // conversation at the end, and being at the end is what marks it read.
      landOn="unread"
      landingReady={isHydrated}
      onReachedBottom={markSeen}
      transcriptAnnouncement={announcement}
      approvalAnnouncement={approvalAnnouncement}
      className="pt-12"
      loading={
        isLoadingHistory ? (
          // The same feed the loaded conversation renders, saying it is BUSY —
          // which is what the pattern asks for, and what turns a silent wait
          // into one a screen reader can report.
          <Feed
            label={TRANSCRIPT_FEED_LABEL}
            busy
            className="flex h-full items-center justify-center"
            data-testid="transcript-feed-loading"
          >
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <TypingDots />
              Loading conversation...
            </div>
          </Feed>
        ) : undefined
      }
      empty={
        <div className="flex h-full items-center justify-center">
          <ChatEmptyState birthRecord={birthRecord} firstLightRecord={firstLightRecord} />
        </div>
      }
      data-testid="message-list"
      feedTestId="transcript-feed"
    />
  );
}

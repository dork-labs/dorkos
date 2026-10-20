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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  createListRowsCache,
  ChatEmptyState,
  resolveMessageAuthor,
  StagedContextNote,
  StartedPrompt,
  TypingDots,
  useApprovalAnnouncer,
  useStreamingAnnouncer,
  type InteractiveToolHandle,
  type ListRow,
  type MessageAuthorContext,
  ChatStopLine,
  interleaveStopNotices,
  useChatActivity,
  useEarlierMessages,
} from '@/layers/features/chat';
import { SessionMessage } from './SessionMessage';
import { withDirectNotes, type DirectChatLog } from '../model/use-direct-chat-notes';
import type { DirectMessageSurface } from '../model/use-session-surface';
import { LoadEarlierRow } from './LoadEarlierRow';
import { useRenderSlot, useStableCallback } from '@/layers/shared/lib';

/**
 * What the transcript is called when a screen reader lands in it.
 *
 * Generic on purpose: a session's chat has no title of its own on screen, and
 * inventing one would name the feed after something the reader cannot see.
 */
const TRANSCRIPT_FEED_LABEL = 'Conversation';

/** The "Earlier messages" control's row: one object, so it is never a new row. */
const LOAD_EARLIER_ROW: ConversationRow = {
  kind: 'notice',
  id: 'session-load-earlier',
  at: '',
  body: null,
};

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
  /**
   * Called once when a sign-in started from an inline auth-error card
   * completes, so the failed message can send itself (DOR-1650). Returns
   * whether it did.
   */
  onSigninComplete?: () => boolean;
  /** Opens the active session's model picker from a model error card. */
  onChooseModel?: () => void;
  /** Tool call ID rendered in the input zone (to skip in the transcript). */
  inputZoneToolCallId?: string | null;
  /** Text animation effect for streaming text. */
  textEffect?: TextEffectConfig;
  /** Display name of the session's runtime (e.g. "Claude"), for auth-error copy. */
  runtimeLabel?: string;
  /**
   * Whether this session's runtime can deliver a free-text deny reason to the
   * agent. Threaded to every row's `MessageProvider` (DOR-825) — the composer's
   * own approval card gets this from `SessionComposer`'s identical resolution;
   * this is the SEPARATE path for a parked or batched approval the transcript
   * renders directly, which never passes through the composer at all.
   */
  allowsDenyReason?: boolean;
  /**
   * The row this transcript was ASKED to open on, read once (DOR-1579).
   *
   * It outranks the unread rule and the newest message because it is the only
   * one of the three somebody asked for — see `TimelineLandingInput.landOnRow`.
   */
  landOnRow?: () => string | undefined;
  /**
   * Fold the first thing the chat was asked under one quiet line ("What it was
   * asked ▸"). Set when an extension or another chat started it (spec
   * `flow-multiproject` §7.7): that prompt was written for the agent, and the
   * chat's first line already says, for the person, why it exists.
   */
  foldFirstPrompt?: boolean;
  /**
   * The log under an agent's Direct chat (rule S12), read by the chat panel.
   * Its pings are drawn where they landed. Absent for an ordinary chat.
   */
  directLog?: DirectChatLog;
  /**
   * Set while this chat reads as a direct message with one agent (DOR-3074):
   * every reply wears that agent's face and name, and the person's own
   * messages their name, the way a room draws them. Absent for a session.
   */
  directMessage?: DirectMessageSurface | null;
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
  messages: windowTranscript,
  sessionId,
  isLoadingHistory = false,
  hydrated = false,
  isTextStreaming = false,
  activeToolCallId = null,
  onToolRef: onToolRefProp,
  focusedOptionIndex = -1,
  onToolDecided: onToolDecidedProp,
  onRetry: onRetryProp,
  onSigninComplete: onSigninCompleteProp,
  onChooseModel: onChooseModelProp,
  inputZoneToolCallId = null,
  textEffect,
  runtimeLabel,
  allowsDenyReason,
  landOnRow,
  foldFirstPrompt = false,
  directLog,
  directMessage = null,
}: SessionTranscriptProps) {
  // Row handlers keep one identity, so a row whose message did not change can
  // skip its render: `onRetry` alone used to change on every streamed word, and
  // with it every visible row re-drew its markdown (DOR-2895).
  const onToolRef = useStableCallback(onToolRefProp);
  const onToolDecided = useStableCallback(onToolDecidedProp);
  const onRetry = useStableCallback(onRetryProp);
  const onSigninComplete = useStableCallback(onSigninCompleteProp);
  const onChooseModel = useStableCallback(onChooseModelProp);
  // A "Stopped by" line wherever another chat's agent stopped this one (spec
  // `spin-off-chats` §6), placed by when it happened. The rows are drawn from
  // this list; every rule about MESSAGES — what is new, what is final, where
  // a message sits in the feed, what has been read — counts the transcript
  // itself, because a stop line is not a message and one arriving late must
  // not shift any of them.
  // A long conversation opens on its newest messages; older pages the reader
  // asked for go in front (DOR-2889). Everything below counts them as messages.
  const earlier = useEarlierMessages(sessionId, windowTranscript);
  const transcript = earlier.messages;
  const { stops } = useChatActivity(sessionId);
  // An agent's Direct chat also draws the pings that reached it from the
  // agent's other chats, where they landed (rule S12). Like stop lines, they
  // are not transcript messages, so none of the rules below count them.
  const transcriptWhole = !earlier.canLoadEarlier;
  const direct = useMemo(
    () => withDirectNotes(transcript, directLog, transcriptWhole),
    [transcript, directLog, transcriptWhole]
  );
  const messages = useMemo(
    () => interleaveStopNotices(direct.messages, stops),
    [direct.messages, stops]
  );
  // Each row's position among the messages, or -1 for a stop line or a note.
  const transcriptIndex = useMemo(() => {
    let next = 0;
    return messages.map((m) => (m._chatStop || m._directNote ? -1 : next++));
  }, [messages]);
  // How long the transcript was when this mount first had one — the line between
  // history and what arrived since, which decides which rows animate. Latched in
  // a slot rather than state: it is read in the same render that captures it, and
  // capturing it must not cause a render of its own.
  // Counted in the whole conversation (`messagesBefore`), so neither an older
  // page read in front nor a whole-history reload shifts the line (DOR-2889).
  const historyCount = useRenderSlot<number | null>(null);
  if (historyCount.read() === null && transcript.length > 0)
    historyCount.write(earlier.messagesBefore + transcript.length);
  const lastWidgetFenceIndex = useMemo(() => findLastWidgetFenceIndex(messages), [messages]);
  // The first message a person would have typed, when it is folded: the first
  // plain user turn. -1 when nothing is folded.
  // Only when the loaded messages start at the beginning: in a long chat's
  // window, the first user message is not the one that started it.
  const foldedPromptIndex = useMemo(
    () =>
      foldFirstPrompt && !earlier.canLoadEarlier
        ? messages.findIndex(
            (m) =>
              m.role === 'user' &&
              m.messageType === undefined &&
              !m._stagedContext &&
              !m._chatStop &&
              !m._directNote
          )
        : -1,
    [foldFirstPrompt, earlier.canLoadEarlier, messages]
  );
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
  const dmAgent = directMessage?.agent ?? null;
  // Every DM message names its time (DOR-3074). One with none of its own (a
  // reply still arriving, or history a runtime keeps without times) shows when
  // this transcript first drew it, kept so it never moves.
  const stampsUntimed = directMessage?.settled === true;
  const [firstSeen] = useState(() => new Map<string, string>());
  const untimedAt = useCallback(
    (message: ChatMessage): string | undefined => {
      if (!stampsUntimed || message.timestamp) return undefined;
      const known = firstSeen.get(message.id);
      if (known) return known;
      const now = new Date().toISOString();
      firstSeen.set(message.id, now);
      return now;
    },
    [stampsUntimed, firstSeen]
  );
  // A live turn's stand-in rows reuse one id from turn to turn, so a stand-in
  // that has left the transcript forgets its time and the next turn's is new.
  useEffect(() => {
    const present = new Set(messages.map((message) => message.id));
    for (const id of firstSeen.keys()) {
      if (id.startsWith('__') && !present.has(id)) firstSeen.delete(id);
    }
  }, [messages, firstSeen]);
  const humanName = directMessage?.humanName ?? null;
  const authorContext = useMemo<MessageAuthorContext>(
    () => ({
      // A DM names the agent it is with, whatever folder is selected.
      agent:
        dmAgent ??
        (currentAgent
          ? {
              id: currentAgent.id,
              displayName: getAgentDisplayName(currentAgent),
              ...resolveAgentVisual(currentAgent),
            }
          : null),
      runtime,
      ...(humanName ? { humanName } : {}),
    }),
    [currentAgent, runtime, dmAgent, humanName]
  );

  // The turn happening NOW, mirrored into a live region below. The feed itself
  // announces nothing — that is what a feed is — so this is the only thing that
  // says an answer is arriving without the reader having to go and look.
  const newest = transcript[transcript.length - 1];
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
    transcript,
    earlier.messagesBefore
  );

  // Rows, not messages, are what the list virtualizes: dividers are real rows so
  // their heights participate in measurement. Memoized on the messages array,
  // exactly as the role-based grouping it replaces was — so `now` (which only
  // phrases day labels as Today/Yesterday) is re-read whenever the list changes.
  // Accepted consequence: a tab left idle across midnight keeps yesterday's
  // "Today" chip until the next message lands. Re-labelling a silent transcript
  // is not worth a timer.
  // The clock those labels are phrased against. Read at mount and again, as the
  // list changes, only when the day itself has turned — render may not read the
  // clock, and a fresh reading on every streamed token would re-render the whole
  // transcript for a label that says the same thing.
  const [now, setNow] = useState(() => Date.now());
  const anchoredDay = useRef<string | null>(null);
  useLayoutEffect(() => {
    const sampled = Date.now();
    const day = new Date(sampled).toDateString();
    if (anchoredDay.current === null) {
      // The mount's reading is the `useState` initializer above.
      anchoredDay.current = day;
      return;
    }
    if (anchoredDay.current !== day) {
      anchoredDay.current = day;
      setNow(sampled);
    }
  }, [messages]);

  // The layout reuses the rows of everything a streamed word did not change,
  // so a long chat is not laid out again per word (DOR-2912). That needs the
  // author resolver to keep its identity until the authors themselves change.
  const resolveAuthor = useCallback(
    (message: ChatMessage) => resolveMessageAuthor(message, authorContext),
    [authorContext]
  );
  const [layoutCache] = useState(createListRowsCache);
  const listRows = useMemo(
    () =>
      buildListRows(messages, {
        resolveAuthor,
        now,
        // An unread ping in a Direct chat is where the reader left off.
        lastSeenMessageId: direct.lastSeenBeforeUnread ?? lastSeenMessageId,
        unreadFromStart: direct.unreadFromStart || unreadFromStart,
        cache: layoutCache,
      }),
    [messages, resolveAuthor, now, lastSeenMessageId, unreadFromStart, direct, layoutCache]
  );

  // One view row per layout row, kept with it, so reused layout rows hand the
  // timeline the very same objects as last time.
  const [viewRows] = useState(() => new WeakMap<ListRow, ConversationRow>());
  const rows = useMemo<ConversationRow[]>(() => {
    const built = listRows.map((row) => {
      const known = viewRows.get(row);
      if (known) return known;
      const view: ConversationRow =
        row.kind === 'day-divider'
          ? { kind: 'day-divider', id: row.key, label: row.label }
          : row.kind === 'unread-divider'
            ? { kind: 'unread-divider', id: row.key }
            : {
                kind: 'message',
                id: row.key,
                payload: row.message,
                grouping: row.grouping,
                author: row.author,
                at: row.message.timestamp,
              };
      viewRows.set(row, view);
      return view;
    });
    // Above everything, as the ceiling of what is loaded (see `LoadEarlierRow`).
    return earlier.canLoadEarlier ? [LOAD_EARLIER_ROW, ...built] : built;
  }, [listRows, viewRows, earlier.canLoadEarlier]);
  const rowOffset = earlier.canLoadEarlier ? 1 : 0;

  /**
   * Render one row by kind.
   *
   * Every message-position rule reads `row.messageIndex` — the index into the
   * ORIGINAL messages array — never the row index, which dividers shift. Using
   * the row index here would freeze live widgets and animate history.
   */
  const renderRow = useCallback<ConversationRowRenderer>(
    (_row, ctx) => {
      if (rowOffset === 1 && ctx.index === 0) {
        return <LoadEarlierRow loading={earlier.isLoadingEarlier} onLoad={earlier.loadEarlier} />;
      }
      const row: ListRow = listRows[ctx.index - rowOffset]!;
      if (row.kind === 'day-divider') return <DayDivider label={row.label} />;
      if (row.kind === 'unread-divider') return <UnreadDivider />;

      const { message, messageIndex } = row;

      // A staged-context note is not a turn: it renders as a quiet standalone
      // row, never a message bubble with an avatar and grouping. Branch before
      // SessionMessage so none of that chrome applies to it.
      if (message._stagedContext) return <StagedContextNote content={message.content} />;

      // Another chat's agent stopped this one here: a quiet system line, with
      // none of a message's chrome (spec `spin-off-chats` §6).
      if (message._chatStop) {
        return (
          <div className="px-4 py-1">
            <ChatStopLine notice={message._chatStop} />
          </div>
        );
      }

      // A started chat's prompt: readable, never the headline. A spin-off's
      // first message reads as the words another chat sent, never their fence.
      if (messageIndex === foldedPromptIndex) {
        return <StartedPrompt content={message.chatMessages?.[0]?.text ?? message.content} />;
      }

      // Where this message sits among the messages, stop lines not counted.
      const position = transcriptIndex[messageIndex] ?? messageIndex;

      // The session's last message, whoever wrote it. An inline error card
      // offers Retry from here and nowhere else (DOR-1677): Retry re-sends the
      // last USER message, which is the prompt this card is about only while
      // nothing has come after it. Anything following takes the offer away —
      // the next prompt, a steer, or the staged note two branches up, which is
      // a user-role message even though it draws no bubble.
      const isFinalMessage = position >= 0 && position === transcript.length - 1;
      const isLastAssistant = isFinalMessage && message.role === 'assistant';
      // Fence-based supersede (DOR-302): a widget in this message is stale only
      // when a NEWER fence-bearing message exists. Fence-less messages get
      // `true` vacuously (they render no widget).
      const isLatestWidgetMessage =
        lastWidgetFenceIndex === -1 || messageIndex >= lastWidgetFenceIndex;
      // The history line as of THIS call, so a row drawn before the transcript
      // first had messages is still judged against the latch that landed since.
      const history = historyCount.read();

      return (
        <SessionMessage
          message={message}
          grouping={row.grouping}
          author={row.author}
          sessionId={sessionId}
          directRoomId={directLog?.roomId}
          fallbackAt={untimedAt(message)}
          isNew={history !== null && earlier.messagesBefore + position >= history}
          isStreaming={isLastAssistant && isTextStreaming}
          isLatestWidgetMessage={isLatestWidgetMessage}
          isFinalMessage={isFinalMessage}
          activeToolCallId={activeToolCallId}
          onToolRef={onToolRef}
          focusedOptionIndex={focusedOptionIndex}
          onToolDecided={onToolDecided}
          onRetry={onRetry}
          onSigninComplete={onSigninComplete}
          onChooseModel={onChooseModel}
          inputZoneToolCallId={inputZoneToolCallId}
          textEffect={textEffect}
          runtimeLabel={runtimeLabel}
          allowsDenyReason={allowsDenyReason}
          // Counted over the messages themselves, which is exactly the set of
          // articles this feed holds: the day and unread rules are separators
          // between articles, so numbering them would promise stops Page Down
          // never makes.
          feedPosition={{ index: position + 1, total: transcript.length }}
        />
      );
    },
    [
      listRows,
      rowOffset,
      earlier.isLoadingEarlier,
      earlier.loadEarlier,
      earlier.messagesBefore,
      transcript.length,
      transcriptIndex,
      lastWidgetFenceIndex,
      foldedPromptIndex,
      sessionId,
      directLog?.roomId,
      untimedAt,
      historyCount,
      isTextStreaming,
      activeToolCallId,
      onToolRef,
      focusedOptionIndex,
      onToolDecided,
      onRetry,
      onSigninComplete,
      onChooseModel,
      inputZoneToolCallId,
      textEffect,
      runtimeLabel,
      allowsDenyReason,
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
      // A link to an old message waits until the pages holding it are read.
      landingReady={isHydrated && !earlier.isSeeking && (directLog?.ready ?? true)}
      {...(landOnRow === undefined ? {} : { landOnRow })}
      onReachedBottom={markSeen}
      transcriptAnnouncement={announcement}
      approvalAnnouncement={approvalAnnouncement}
      // The pad the session's own chrome needs, and the matching start for the
      // scroll thumb's track — one fact, said once (`ScrollThumb`).
      className="pt-12 [--conversation-thumb-top:3rem]"
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
              Loading chat…
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

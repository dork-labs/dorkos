/**
 * The session's conversation, whole: transcript, live lane, composer and the
 * panels around them.
 *
 * The host every session mounts — the `/session` route, the Obsidian embed and
 * the dev simulator alike. It is a WIDGET because a conversation host composes
 * features (`features/chat`'s model, `features/conversation`'s compound) and
 * only a widget may; P4 moved it up here from `features/chat`, which is what
 * let the capability table and the body renderer come with it.
 *
 * @module widgets/session/ui/ChatPanel
 */
import { useRef, useMemo, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import type { TaskUpdateEvent } from '@dorkos/shared/types';
import { useAgentBirthRecord, useSlotContributions } from '@/layers/shared/model';
import {
  PermissionPrimer,
  useNotificationCues,
  usePermissionPrimer,
} from '@/layers/features/notifications';
import { BottomSlot, PromptSuggestionChips, type BottomSlotCandidate } from '@/layers/shared/ui';
import { useCommands } from '@/layers/entities/command';
import {
  useSessionChatStore,
  useSessionId,
  useSessionQueue,
  useSessionStatus,
  useSessionStreamLifecycle,
  useSessionStreamStatus,
  useSessionToolActivity,
  useDirectoryState,
  sessionKeys,
} from '@/layers/entities/session';
import { useCapabilitiesForRuntime, getRuntimeDescriptor } from '@/layers/entities/runtime';
import { useCurrentAgent } from '@/layers/entities/agent';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { useRuntimeChip } from '@/layers/features/status';
import { useFiles } from '@/layers/features/files';
import { Conversation, NO_ASKS } from '@/layers/features/conversation';
import type { ComposerInputHandle } from '@/layers/features/composer';
import {
  BirthCertificate,
  CelebrationOverlay,
  ErrorMessageBlock,
  TaskListPanel,
  TerminalReasonChip,
  TurnFailedNotice,
  buildFileEntries,
  buildPaletteCommands,
  compactComposerGate,
  resolveSigninResumeText,
  resolveTransportRetryText,
  selectWaitingQueue,
  shouldShowTurnFailedNotice,
  useChatSession,
  useChatStatusSync,
  useCelebrations,
  useDorkBotSeed,
  useFileUpload,
  useInputAutocomplete,
  useLaunchPrompt,
  useSigninResumeClaim,
  useTaskState,
  useToolShortcuts,
} from '@/layers/features/chat';
import { SESSION_CAPABILITIES } from '../model/session-capabilities';
import { useSessionLaneState } from '../model/use-session-lane-state';
import { useSessionTarget } from '../model/session-target';
import { SessionComposer } from './SessionComposer';
import { SessionTranscript } from './SessionTranscript';

interface ChatPanelProps {
  sessionId: string | null;
  /** Optional transform applied to message content before sending to server */
  transformContent?: (content: string) => string | Promise<string>;
  /**
   * Runtime selected at launch (the `?runtime=` search param). Sent as the
   * runtime hint on the session-creating first message; absent means the
   * server resolves the runtime (agent manifest, then server default).
   */
  launchRuntime?: string;
  /**
   * Prompt to seed the composer with on a freshly-launched session (the
   * `?prompt=` search param — a "Run this with…" re-run, a docs try-it link).
   * Seeded once, only while the conversation is empty and the composer is
   * untouched. See {@link useLaunchPrompt} for the once-only guarantees.
   */
  launchPrompt?: string;
  /**
   * Whether that seed should also be SENT (`?send=1`) rather than only
   * pre-filled. Goes through the composer's own submit, exactly once.
   */
  launchSend?: boolean;
  /**
   * The `?seed=` value (`'dorkbot-help'` and nothing else today): background the
   * first turn carries, never text. See {@link useDorkBotSeed}.
   */
  launchSeed?: string;
  /**
   * Fired when a launch link is spent, so the caller can drop `prompt`, `send`
   * and `seed` from the URL — the guard against a refresh or a Back re-issuing
   * one.
   */
  onLaunchConsumed?: () => void;
  /**
   * The row this conversation was ASKED to open on — a message-search hit,
   * addressed in the URL (DOR-1579). Passed straight to the transcript's
   * landing, which reads it once; see `useMessageLanding`.
   */
  landOnRow?: () => string | undefined;
}

/** Top-level chat view composing message list, input, task panel, and celebration effects. */
export function ChatPanel({
  sessionId,
  transformContent,
  launchRuntime,
  launchPrompt,
  launchSend = false,
  launchSeed,
  onLaunchConsumed,
  landOnRow,
}: ChatPanelProps) {
  const [, setSessionId] = useSessionId();
  const queryClient = useQueryClient();
  const chatInputRef = useRef<ComposerInputHandle>(null);
  const taskState = useTaskState(sessionId);
  // What this session is doing right now, from the same fleet-wide status
  // stream the sidebar reads — one derivation, so the strip and the roster can
  // never name two different tools for one session.
  const activity = useSessionToolActivity(sessionId ?? '');
  const celebrations = useCelebrations();
  // The turn-finished chime. Off unless somebody asked for it — the cue hook
  // owns that question, so this call site simply says when a turn ended.
  const { play: playCue } = useNotificationCues();
  const [cwd] = useDirectoryState();

  const fileUpload = useFileUpload();

  /**
   * Transform applied to outgoing message content on submit.
   *
   * Uploads any pending files, converts their absolute saved paths to paths
   * relative to the selected working directory, then prepends a read-files
   * instruction block before delegating to any caller-supplied transform.
   */
  const fileTransformContent = useCallback(
    async (content: string): Promise<string> => {
      let result = content;

      if (fileUpload.hasPendingFiles) {
        const savedPaths = await fileUpload.uploadAndGetPaths();
        const relativePaths = cwd
          ? savedPaths.map((p) => (p.startsWith(cwd) ? p.slice(cwd.length).replace(/^\//, '') : p))
          : savedPaths;

        if (relativePaths.length > 0) {
          const fileList = relativePaths.map((p) => `- ${p}`).join('\n');
          result = `Please read the following uploaded file(s):\n${fileList}\n\n${result}`;
        }

        fileUpload.clearFiles();
      }

      return transformContent ? transformContent(result) : result;
    },
    [fileUpload, cwd, transformContent]
  );

  const handleTaskEventWithCelebrations = useCallback(
    (event: TaskUpdateEvent) => {
      taskState.handleTaskEvent(event);
      const projectedTasks = taskState.tasks.map((t) =>
        t.id === event.task.id ? { ...t, ...event.task } : t
      );
      celebrations.handleTaskEvent(event, projectedTasks);
    },
    [taskState, celebrations]
  );

  const handleSessionIdChange = useCallback(
    (newId: string) => {
      setSessionId(newId);
      // Invalidate stale session metadata so the new key fetches immediately
      // instead of waiting for TanStack Query's staleTime to expire.
      queryClient.invalidateQueries({ queryKey: sessionKeys.bySession(newId) });
    },
    [setSessionId, queryClient]
  );

  /**
   * Rewrite the URL to the SDK-canonical id IN PLACE after the create-on-
   * first-message trigger (no history push), so the optimistic client UUID is
   * silently superseded and Back does not return to the throwaway URL.
   */
  const handleSessionIdChangeReplace = useCallback(
    (canonicalId: string) => {
      setSessionId(canonicalId, { replace: true });
      queryClient.invalidateQueries({ queryKey: sessionKeys.bySession(canonicalId) });
    },
    [setSessionId, queryClient]
  );

  /**
   * `/clear` navigation: open a fresh session in the same project (the setter
   * preserves the `dir` param), recording the prior session as the new one's
   * lightweight `continuedFrom` link (DOR-109). No message is sent.
   */
  const startFreshSession = useCallback(
    (fromSessionId: string | null) => {
      setSessionId(crypto.randomUUID(), { continuedFrom: fromSessionId ?? undefined });
    },
    [setSessionId]
  );

  // Resolve the session's runtime + its capabilities up front: they gate the
  // palette's honest disabled row AND the composer's /compact dispatch, both of
  // which must agree. Same source ChatStatusSection's runtime chip uses (a
  // not-yet-started Codex session resolves to Codex, not the claude-code default).
  const runtimeChip = useRuntimeChip(sessionId ?? '');
  const activeCaps = useCapabilitiesForRuntime(runtimeChip.runtime);
  const runtimeLabel = runtimeChip.runtime ? getRuntimeDescriptor(runtimeChip.runtime).label : '';
  // Whether a deny reason typed on a transcript-rendered approval reaches the
  // agent at all (DOR-825). Same resolution `SessionComposer` does for the
  // input-zone card — this is the SEPARATE path for a parked or batched
  // approval the transcript renders directly, via `MessageContext`, which
  // never passes through the composer. `true` while capabilities are still
  // loading and for every runtime that has not opted out.
  const allowsDenyReason = activeCaps?.permissionModes?.denyReason ?? true;
  // Compact gate injected into the send funnel: recognize + dispatch /compact
  // when supported, honestly refuse (toast, keep text) when the runtime declares
  // it unsupported. Optimistic while capabilities load — matching the palette
  // gate in buildPaletteCommands, so the two surfaces never disagree during the
  // caps-loading window (the server's 422 is the backstop for a wrong optimism).
  const compactIntent = useMemo(
    () => compactComposerGate(activeCaps?.commandIntents, runtimeLabel),
    [activeCaps, runtimeLabel]
  );

  // Ask DorkBot's hidden preamble reaches the send path through this indirection
  // because the hook that builds it needs `messages.length` and `hydrated`,
  // which the session hook below RETURNS — so the option handed down has to be a
  // stable shim whose target is filled in after.
  const takeSeedRef = useRef<(() => string | undefined) | null>(null);
  const takeSeedContext = useCallback(() => takeSeedRef.current?.(), []);

  const {
    messages,
    input,
    setInput,
    handleSubmit,
    submitContent,
    enqueueContent,
    steerContent,
    addContextContent,
    status,
    error,
    stop,
    isLoadingHistory,
    hydrated,
    sessionStatus,
    streamStartTime,
    estimatedTokens,
    isTextStreaming,
    isWaitingForUser,
    waitingType,
    activeInteraction,
    pendingInteractions,
    markToolCallResponded,
    systemStatus,
    operationProgress,
    promptSuggestions,
    syncConnectionState,
    retryMessage,
    tryNativeCommand,
    commandPending,
  } = useChatSession(sessionId, {
    transformContent: fileTransformContent,
    onTaskEvent: handleTaskEventWithCelebrations,
    onSessionIdChange: handleSessionIdChange,
    onSessionIdChangeReplace: handleSessionIdChangeReplace,
    startFreshSession,
    compactIntent,
    launchRuntime,
    takeSeedContext,
    onStreamingDone: useCallback(() => {
      playCue('turn-end');
      // After first SDK query completes, commands cache is populated on server.
      // Invalidate the client query so built-ins/skills/user-level commands appear.
      void queryClient.invalidateQueries({ queryKey: ['commands'] });
    }, [playCue, queryClient]),
  });
  /**
   * Start a turn with the composer's words, and empty the box once they are
   * genuinely on their way.
   *
   * The session's half of `ConversationTarget.send`. Written here rather than in
   * the composer because the target is built here, and it is the only send the
   * composer has — pressing Enter in a session reaches the runtime through this
   * and through nothing else (DOR-1354).
   */
  const sendMessage = useCallback(
    (content: string) => submitContent(content, { clearInput: true }),
    [submitContent]
  );

  const { permissionMode } = useSessionStatus(sessionId, sessionStatus, status === 'streaming');

  const { handleToolRef, focusedOptionIndex } = useToolShortcuts(activeInteraction);

  useChatStatusSync(status, isWaitingForUser, taskState.activeForm, isTextStreaming);

  // Focus the prompt textarea whenever the session changes (new session, switch, page mount).
  // Every navigation scenario — sidebar click, new session, agent switch, page load —
  // results in sessionId changing, so this single effect covers all of them.
  // Desktop only: nobody asked for focus here, and on a phone this fires on
  // mount and on every session switch, popping the software keyboard each time.
  useEffect(() => {
    chatInputRef.current?.focusUnlessTouch();
  }, [sessionId]);

  // Apply the launch deep link (`?prompt=`, `?send=1`): pre-fill the composer,
  // and with the opt-in start the turn — each at most once, only into an empty
  // conversation, and through the composer's own submit rather than a parallel
  // path. Everything that makes "once" true lives in the hook.
  const handleLaunchSeeded = useCallback(() => {
    chatInputRef.current?.focusUnlessTouch();
  }, []);
  useLaunchPrompt({
    sessionId,
    prompt: launchPrompt,
    autoSend: launchSend,
    input,
    setInput,
    messageCount: messages.length,
    hydrated,
    status,
    submit: handleSubmit,
    onSeeded: handleLaunchSeeded,
    onConsumed: onLaunchConsumed,
  });

  // Ask DorkBot (`?seed=dorkbot-help`): no words, no focus change — the composer
  // is already empty and already focused by the effect above. All this arms is
  // the background the FIRST send carries.
  const takeDorkBotSeed = useDorkBotSeed({
    sessionId,
    seed: launchSeed,
    messageCount: messages.length,
    hydrated,
    onConsumed: onLaunchConsumed,
  });
  useEffect(() => {
    takeSeedRef.current = takeDorkBotSeed;
  }, [takeDorkBotSeed]);

  // Thread the session's runtime so a not-yet-started Codex session's palette
  // resolves to Codex's project skills rather than the inferred claude-code
  // default. Runtime + caps are resolved above (they also gate /compact dispatch).
  // Friendly product name ("Claude", not the descriptor's "Claude Code") for the
  // inline auth-error copy, resolved router-free here and threaded down so an
  // auth failure names the runtime ("Your Claude sign-in expired"). Matches the
  // label TurnFailedNotice uses, so both auth-error render paths read the same.
  const runtimeAuthLabel = runtimeChip.runtime
    ? runtimeDisplayName(runtimeChip.runtime)
    : undefined;
  const { data: registry } = useCommands(
    cwd,
    sessionId ?? undefined,
    runtimeChip.runtime ?? undefined
  );
  // Project the shared command-intent registry into one palette row per intent
  // (/compact, /clear, /context), folding each runtime's native command for the
  // same action into that single row, then blend the DorkOS-native commands
  // (/rename) and the remaining runtime commands (DOR-109). The send path
  // intercepts intents and native commands before any runtime POST.
  const allCommands = useMemo(
    () =>
      buildPaletteCommands(registry?.commands ?? [], {
        commandIntents: activeCaps?.commandIntents,
        runtimeLabel,
      }),
    [registry, activeCaps, runtimeLabel]
  );
  const { data: fileList } = useFiles(cwd);
  const allFileEntries = useMemo(
    () => (fileList?.files ? buildFileEntries(fileList.files) : []),
    [fileList]
  );

  const autocomplete = useInputAutocomplete({
    input,
    setInput,
    commands: allCommands,
    fileEntries: allFileEntries,
  });

  /** Re-send the last user message after an inline execution_error. */
  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg?.content) {
      submitContent(lastUserMsg.content);
    }
  }, [messages, submitContent]);

  // The active session's birth record, so a failed onboarding first-message send
  // can still be retried — its text lives only in the record, not the transcript.
  const birthRecord = useAgentBirthRecord(sessionId ?? '');

  /** Retry the last user message after a transport-level POST stream failure. */
  const handleTransportRetry = useCallback(() => {
    const text = resolveTransportRetryText(messages, birthRecord);
    if (text) {
      retryMessage(text);
    }
  }, [messages, birthRecord, retryMessage]);

  const showSuggestions = status === 'idle' && promptSuggestions.length > 0 && input.length === 0;

  // In-session suggestion-chip slot (DOR-419). Contributions self-gate (they
  // render null when they have nothing to offer), so this stays mounted.
  const suggestionChips = useSlotContributions('chat.suggestion-chips');

  // Turn-failed retry affordance: `status === 'error'` (settled from
  // turn_end{terminalReason:'error'}) fires for every runtime. A typed error
  // event usually also folds an inline error part into the turn, which
  // suppresses this notice — it renders only when no other error surface
  // already shows the failure (see shouldShowTurnFailedNotice).
  const showTurnFailedNotice = shouldShowTurnFailedNotice(status, error, messages);
  const hasUserMessage = useMemo(() => messages.some((m) => m.role === 'user'), [messages]);

  const handleSuggestionClick = useCallback(
    (suggestion: string) => {
      setInput(suggestion);
      chatInputRef.current?.focus();
    },
    [setInput]
  );

  // What the live lane says about this session. Derived here rather than inside
  // the lane so the lane stays a renderer every surface drives the same way.
  // **The session's lane does NOT draw its own prompts, and that is the
  // decision.** This surface already shows every one of them twice — the live
  // card in the input zone, which is where a person answers it, and the receipt
  // row in the transcript where it was asked. §4.1 promises one card in the
  // transcript and one entry in the tray; a third line six pixels above the card
  // it duplicates is the noise this programme exists to remove, and it would
  // push the amber rung over the elapsed/tokens reading that IS this lane's job.
  //
  // The rung itself is not dead: the room's lane is the surface with no inline
  // card, and it draws it (`RoomLiveLane`). The header tray covers this session
  // from every OTHER route.
  const sessionAsks = NO_ASKS;

  // The queue lives on the server; this window reads it out of the session
  // projection and narrows it to the messages that are genuinely waiting. Read
  // HERE rather than in the composer because it is what the lane's "1 queued"
  // rung counts too, and one fact has one source.
  const serverQueue = useSessionQueue(sessionId ?? '');
  const lifecycle = useSessionStreamLifecycle(sessionId ?? '');
  const waiting = useMemo(
    () => selectWaitingQueue(serverQueue, lifecycle),
    [serverQueue, lifecycle]
  );

  // What the failed turn's typed error said, when it left one. The auth card
  // renders on two paths and only one of them folds an inline error part into
  // the turn; this is the other one's only evidence (see `TurnFailedNotice`).
  const lastErrorCategory = useSessionStreamStatus(sessionId ?? '')?.lastError?.category;

  // What the OTHER windows are doing about this session's failed turn. The
  // once-only latch behind the resume is per-QueryClient, so it is per tab; a
  // person who pressed Sign in in two windows gets both callbacks off the one
  // attempt the server joined them onto. See the module for what this narrows
  // and what it does not.
  const resumeClaim = useSigninResumeClaim();

  /**
   * Put the failed message back on its way once a sign-in fixes what broke it —
   * the whole point of signing in from the error card (DOR-1650). Someone who
   * got signed out mid-task signs in once, and their message sends itself.
   *
   * Fires at most once per sign-in: the guarantee lives in
   * `useDelegateRuntimeLogin`, keyed by mutation id in a per-QueryClient map, so
   * a card that unmounts and remounts as the virtualized transcript scrolls
   * rejoins the same settled attempt instead of announcing it again.
   *
   * `resolveSigninResumeText` owns the decision and every way it can be "no";
   * this only carries it out, and reports back so the card claims to be sending
   * only when it is. Deliberately no `clearInput` — the composer is untouched,
   * and a draft in it is one of the reasons the rule declines in the first
   * place. A re-send that fails is an ordinary failed turn from here: it draws
   * its own error card with its own Retry, and nothing here tries again.
   */
  const handleSigninComplete = useCallback((): boolean => {
    const sid = sessionId ?? '';
    // Another window already said it is re-sending this turn. Standing down is
    // free — its message is the same message this one would send.
    if (resumeClaim.claimedElsewhere(sid)) return false;
    const text = resolveSigninResumeText({
      messages,
      status,
      lastErrorCategory,
      // The RAW server queue, deliberately not `waiting`. `selectWaitingQueue`
      // hides the head row in every lifecycle that is not an open turn — which
      // is precisely the set the resume runs in — because a head with nothing
      // running is "on its way" and should not draw a chip. That is right for a
      // chip and wrong here: a message another client queued (a second tab, a
      // room, MCP, Obsidian) would read as zero, the resume would fire, and the
      // two would run in the order rule 3 exists to prevent. The rule asks
      // "is anything pending at all", not "what would a chip draw".
      queuedCount: serverQueue.length,
      // Read from the store at the moment of the decision rather than closed
      // over, and NOT for tidiness: this callback is threaded into the
      // VIRTUALIZED transcript's row renderer, and the draft changes on every
      // keystroke. Depending on it would mint a new identity per character,
      // invalidate `renderRow`, and re-render every visible row while somebody
      // types. Nothing else in that dependency list moves at typing speed. The
      // live read is also the more correct one — the draft as it is when the
      // sign-in lands is exactly the question the rule asks.
      draft: useSessionChatStore.getState().getSession(sid).input,
    });
    if (text === null) return false;
    // Announced above the send for readability, not for ordering: `submitContent`
    // is async and yields at its first `await`, so both go out in this same
    // synchronous block either way.
    resumeClaim.claim(sid);
    void submitContent(text);
    return true;
  }, [
    messages,
    status,
    lastErrorCategory,
    serverQueue.length,
    sessionId,
    submitContent,
    resumeClaim,
  ]);
  // What the empty box says. The agent registered at the working directory
  // names it; without one it is the generic invitation.
  const { data: composerAgent } = useCurrentAgent(cwd);
  const defaultPlaceholder = composerAgent
    ? `Message ${getAgentDisplayName(composerAgent)}...`
    : 'Send a message...';

  // Where this session's words go, and the files staged against them. Built
  // here rather than inside the composer so the whole conversation can publish
  // it — the lane reads the queue's depth off the same object.
  const sessionTarget = useSessionTarget({
    sessionId: sessionId ?? '',
    placeholder: defaultPlaceholder,
    submit: sendMessage,
    enqueue: enqueueContent,
    files: fileUpload,
  });

  // Whether the browser-notification question is fair to ask right now. Asked
  // here, not inside the card, because the slot below has to know who qualifies
  // before it renders anybody — and because the timer that arms the question has
  // to keep running while another card holds the slot.
  const {
    eligible: primerEligible,
    allow: allowNotifications,
    notNow: declineNotifications,
  } = usePermissionPrimer(status === 'streaming');

  /**
   * What may speak in the gap between the transcript and the composer, highest
   * priority first.
   *
   * **One offer at a time.** Suggestion chips, the extensions' chips and the
   * notification question each used to gate themselves on their own predicate,
   * and they co-occur — three unrelated offers stacked over the box a person is
   * trying to type in. ADR 260819-210153 settled this question for the sidebar;
   * this is the same arbiter, and the order below is the whole of the policy.
   *
   * The order: the model's follow-ups first, because they are about the answer
   * still on screen and they expire on their own the moment a turn starts or a
   * key is pressed — so nothing waits behind them for long. The permission
   * question next: it is asked once ever, it arms mid-turn when the chips are
   * hidden anyway, and it stands until answered. The extension chips last,
   * because a contribution can decide it has nothing to offer only by rendering
   * null, so a card that draws nothing can starve only the cards below it — and
   * below it there are none.
   *
   * What is deliberately NOT here: the live lane (a reserved line by design),
   * the to-do panel (content about the running turn, not an offer), and the
   * error and turn-failed blocks. A failure must never be arbitrated away.
   */
  const offers = useMemo<BottomSlotCandidate[]>(
    () => [
      {
        id: 'prompt-suggestions',
        show: showSuggestions,
        render: () => (
          <PromptSuggestionChips
            suggestions={promptSuggestions}
            onChipClick={handleSuggestionClick}
          />
        ),
      },
      {
        id: 'permission-primer',
        show: primerEligible,
        render: () => (
          <PermissionPrimer onAllow={allowNotifications} onNotNow={declineNotifications} />
        ),
      },
      {
        id: 'extension-chips',
        // Never mid-turn: an extension's offer must not interrupt a running turn.
        show: status === 'idle' && suggestionChips.length > 0,
        render: () => (
          <>
            {suggestionChips.map((chip) => (
              <chip.component key={chip.id} />
            ))}
          </>
        ),
      },
    ],
    [
      showSuggestions,
      promptSuggestions,
      handleSuggestionClick,
      primerEligible,
      allowNotifications,
      declineNotifications,
      status,
      suggestionChips,
    ]
  );

  const laneState = useSessionLaneState({
    asks: sessionAsks,
    status,
    streamStartTime,
    estimatedTokens,
    permissionMode,
    isWaitingForUser: isWaitingForUser ?? false,
    waitingType: waitingType ?? 'approval',
    operationProgress,
    systemStatus,
    activity,
  });

  return (
    // The session's conversation, declared once by the surface every session
    // mounts — the route, the Obsidian embed and the dev simulator alike. Every
    // row, and from P2 the live lane, reads what it can do from here.
    <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES} target={sessionTarget}>
      <div data-testid="chat-panel" className="flex h-full w-full flex-col">
        <BirthCertificate sessionId={sessionId} />

        <SessionTranscript
          messages={messages}
          sessionId={sessionId!}
          isLoadingHistory={isLoadingHistory}
          hydrated={hydrated}
          isTextStreaming={isTextStreaming}
          activeToolCallId={activeInteraction?.toolCallId ?? null}
          onToolRef={handleToolRef}
          focusedOptionIndex={focusedOptionIndex}
          onToolDecided={markToolCallResponded}
          onRetry={handleRetry}
          onSigninComplete={handleSigninComplete}
          inputZoneToolCallId={activeInteraction?.toolCallId ?? null}
          runtimeLabel={runtimeAuthLabel}
          allowsDenyReason={allowsDenyReason}
          {...(landOnRow === undefined ? {} : { landOnRow })}
        />

        <TerminalReasonChip terminalReason={sessionStatus?.terminalReason} />

        {/* The one reserved line, above the composer on every surface. It is
          always 24px tall, so a turn starting or ending moves nothing that is
          already on screen — which the collapsing strip it replaces did on
          every turn. */}
        <Conversation.LiveLane state={laneState} scope="session" />

        {/* Everything that OFFERS rather than reports, arbitrated: one card at
          a time, in the order declared above. */}
        <BottomSlot
          candidates={offers}
          ready={hydrated}
          name="session-bottom-slot"
          className="px-4 pb-2"
        />

        <CelebrationOverlay
          celebration={celebrations.activeCelebration}
          onComplete={celebrations.clearCelebration}
        />

        <TaskListPanel
          tasks={taskState.tasks}
          taskMap={taskState.taskMap}
          activeForm={taskState.activeForm}
          isCollapsed={taskState.isCollapsed}
          onToggleCollapse={taskState.toggleCollapse}
          celebratingTaskId={celebrations.celebratingTaskId}
          onCelebrationComplete={celebrations.clearCelebration}
          statusTimestamps={taskState.statusTimestamps}
        />

        {showTurnFailedNotice && (
          <TurnFailedNotice
            sessionId={sessionId!}
            onRetry={hasUserMessage ? handleRetry : undefined}
            onSigninComplete={handleSigninComplete}
          />
        )}

        {error && (
          <div className="mx-4 mb-2">
            <ErrorMessageBlock
              message={error.message}
              heading={error.heading}
              subtext={error.message}
              onRetry={error.retryable ? handleTransportRetry : undefined}
            />
          </div>
        )}

        <SessionComposer
          chatInputRef={chatInputRef}
          input={input}
          autocomplete={autocomplete}
          steerContent={steerContent}
          addContextContent={addContextContent}
          tryNativeCommand={tryNativeCommand}
          commandPending={commandPending}
          status={status}
          stop={stop}
          setInput={setInput}
          sessionId={sessionId ?? ''}
          sessionStatus={sessionStatus}
          waiting={waiting}
          interaction={{
            active: activeInteraction,
            pendingApprovals: pendingInteractions.filter((tc) => tc.interactiveType === 'approval'),
            focusedOptionIndex,
            onToolRef: handleToolRef,
            onToolDecided: markToolCallResponded,
          }}
          sync={{
            connectionState: syncConnectionState,
          }}
        />
      </div>
    </Conversation.Root>
  );
}

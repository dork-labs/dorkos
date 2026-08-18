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
import { AnimatePresence } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import type { TaskUpdateEvent } from '@dorkos/shared/types';
import { useAppStore, useAgentBirthRecord, useSlotContributions } from '@/layers/shared/model';
import { playNotificationSound } from '@/layers/shared/lib';
import { PromptSuggestionChips } from '@/layers/shared/ui';
import { useCommands } from '@/layers/entities/command';
import {
  useSessionId,
  useSessionStatus,
  useSessionToolActivity,
  useDirectoryState,
  sessionKeys,
} from '@/layers/entities/session';
import { useCapabilitiesForRuntime, getRuntimeDescriptor } from '@/layers/entities/runtime';
import { usePendingInteractions } from '@/layers/entities/attention';
import { useRuntimeChip } from '@/layers/features/status';
import { useFiles } from '@/layers/features/files';
import { InteractionAsk } from '@/layers/features/ask';
import { Conversation } from '@/layers/features/conversation';
import type { ComposerInputHandle } from '@/layers/features/composer';
import {
  BirthCertificate,
  CelebrationOverlay,
  ChatInputContainer,
  ErrorMessageBlock,
  TaskListPanel,
  TerminalReasonChip,
  TurnFailedNotice,
  buildFileEntries,
  buildPaletteCommands,
  compactComposerGate,
  resolveTransportRetryText,
  shouldShowTurnFailedNotice,
  useChatSession,
  useChatStatusSync,
  useCelebrations,
  useDorkBotSeed,
  useFileUpload,
  useInputAutocomplete,
  useLaunchPrompt,
  useTaskState,
  useToolShortcuts,
} from '@/layers/features/chat';
import { SESSION_CAPABILITIES } from '../model/session-capabilities';
import { useSessionLaneState } from '../model/use-session-lane-state';
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
  const enableNotificationSound = useAppStore((s) => s.enableNotificationSound);
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
      if (enableNotificationSound) {
        playNotificationSound();
      }
      // After first SDK query completes, commands cache is populated on server.
      // Invalidate the client query so built-ins/skills/user-level commands appear.
      void queryClient.invalidateQueries({ queryKey: ['commands'] });
    }, [enableNotificationSound, queryClient]),
  });
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
  // This session's own prompts, off the fleet-wide list — the same objects the
  // header tray and the room lane draw, so answering in any of them resolves
  // all of them.
  const { interactions } = usePendingInteractions();
  const sessionAsks = useMemo(
    () => (sessionId === null ? [] : interactions.filter((ask) => ask.sessionId === sessionId)),
    [interactions, sessionId]
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
    <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
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
          inputZoneToolCallId={activeInteraction?.toolCallId ?? null}
          runtimeLabel={runtimeAuthLabel}
        />

        <TerminalReasonChip terminalReason={sessionStatus?.terminalReason} />

        {/* The one reserved line, above the composer on every surface. It is
          always 24px tall, so a turn starting or ending moves nothing that is
          already on screen — which the collapsing strip it replaces did on
          every turn. */}
        <Conversation.LiveLane
          state={laneState}
          scope="session"
          askCard={laneState.kind === 'ask' ? <InteractionAsk ask={laneState.ask} /> : undefined}
        />

        <AnimatePresence>
          {showSuggestions && (
            <PromptSuggestionChips
              suggestions={promptSuggestions}
              onChipClick={handleSuggestionClick}
            />
          )}
        </AnimatePresence>

        {/* Suggestion chips (e.g. the living tour's offer) only appear when the
          session is idle — never interrupt an in-flight turn. */}
        {status === 'idle' && suggestionChips.map((chip) => <chip.component key={chip.id} />)}

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

        <ChatInputContainer
          chatInputRef={chatInputRef}
          input={input}
          autocomplete={autocomplete}
          handleSubmit={handleSubmit}
          enqueueContent={enqueueContent}
          steerContent={steerContent}
          addContextContent={addContextContent}
          tryNativeCommand={tryNativeCommand}
          commandPending={commandPending}
          status={status}
          stop={stop}
          setInput={setInput}
          sessionId={sessionId ?? ''}
          sessionStatus={sessionStatus}
          fileUpload={{
            pendingFiles: fileUpload.pendingFiles,
            onFilesSelected: fileUpload.addFiles,
            onFileRemove: fileUpload.removeFile,
            onFileRetry: fileUpload.retryFile,
            onUploadCancel: fileUpload.cancelUpload,
            isUploading: fileUpload.isUploading,
            hasFailedUpload: fileUpload.hasFailedUpload,
          }}
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

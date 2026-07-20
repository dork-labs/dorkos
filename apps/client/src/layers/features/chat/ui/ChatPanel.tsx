import { useRef, useMemo, useCallback, useEffect } from 'react';
import { AnimatePresence } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { useChatSession } from '../model/use-chat-session';
import { useCommands } from '@/layers/entities/command';
import { useTaskState } from '../model/use-task-state';
import { useToolShortcuts } from '../model/use-tool-shortcuts';
import { useScrollOverlay } from '../model/use-scroll-overlay';
import { useInputAutocomplete } from '../model/use-input-autocomplete';
import { buildPaletteCommands, compactComposerGate } from '../model/build-palette-commands';
import { useChatStatusSync } from '../model/use-chat-status-sync';
import { useRuntimeChip } from '../model/status/use-runtime-chip';
import { useFileUpload } from '../model/use-file-upload';
import { buildFileEntries } from '../lib/build-file-entries';
import { useSessionId, useSessionStatus, useDirectoryState } from '@/layers/entities/session';
import { useCapabilitiesForRuntime, getRuntimeDescriptor } from '@/layers/entities/runtime';
import { useAppStore } from '@/layers/shared/model';
import { playNotificationSound } from '@/layers/shared/lib';
import type { MessageListHandle } from './MessageList';
import type { ChatInputHandle } from './input/ChatInput';
import { ChatMessageArea } from './ChatMessageArea';
import { BirthCertificate } from './BirthCertificate';
import { ChatInputContainer } from './input/ChatInputContainer';
import { TaskListPanel } from './tasks/TaskListPanel';
import { CelebrationOverlay } from './CelebrationOverlay';
import { useFiles } from '@/layers/features/files';
import { useCelebrations } from '../model/use-celebrations';
import { ErrorMessageBlock } from './message/ErrorMessageBlock';
import { ChatStatusStrip } from './status/ChatStatusStrip';
import { TerminalReasonChip, TurnFailedNotice } from './status';
import { shouldShowTurnFailedNotice } from '../model/stream/turn-failure';
import { PromptSuggestionChips } from './input/PromptSuggestionChips';
import type { TaskUpdateEvent } from '@dorkos/shared/types';

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
   * `?prompt=` search param from a "Run this with…" re-run). Seeded once, only
   * while the session is empty, so it pre-fills without ever replacing typed
   * text or re-appearing after the turn has started.
   */
  launchPrompt?: string;
}

/** Top-level chat view composing message list, input, task panel, and celebration effects. */
export function ChatPanel({
  sessionId,
  transformContent,
  launchRuntime,
  launchPrompt,
}: ChatPanelProps) {
  const [, setSessionId] = useSessionId();
  const queryClient = useQueryClient();
  const messageListRef = useRef<MessageListHandle>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const taskState = useTaskState(sessionId);
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
      queryClient.invalidateQueries({ queryKey: ['session', newId] });
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
      queryClient.invalidateQueries({ queryKey: ['session', canonicalId] });
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

  const {
    messages,
    input,
    setInput,
    handleSubmit,
    submitContent,
    status,
    error,
    sessionBusy,
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
  } = useChatSession(sessionId, {
    transformContent: fileTransformContent,
    onTaskEvent: handleTaskEventWithCelebrations,
    onSessionIdChange: handleSessionIdChange,
    onSessionIdChangeReplace: handleSessionIdChangeReplace,
    startFreshSession,
    compactIntent,
    launchRuntime,
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
  const { isAtBottom, hasNewMessages, scrollToBottom, handleScrollStateChange } = useScrollOverlay(
    messages,
    messageListRef
  );

  useChatStatusSync(status, isWaitingForUser, taskState.activeForm, isTextStreaming);

  // Focus the prompt textarea whenever the session changes (new session, switch, page mount).
  // Every navigation scenario — sidebar click, new session, agent switch, page load —
  // results in sessionId changing, so this single effect covers all of them.
  useEffect(() => {
    chatInputRef.current?.focus();
  }, [sessionId]);

  // Seed the composer from a "Run this with…" re-run (`?prompt=`). Guarded so
  // each distinct prompt seeds at most once, and only into an EMPTY session, so
  // it never clobbers typed text or re-fills after the turn has started (the
  // re-run is a fresh session — ADR-0255 — never a transplant of prior history).
  const seededPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (launchPrompt && seededPromptRef.current !== launchPrompt && messages.length === 0) {
      seededPromptRef.current = launchPrompt;
      setInput(launchPrompt);
      chatInputRef.current?.focus();
    }
  }, [launchPrompt, messages.length, setInput]);

  // Thread the session's runtime so a not-yet-started Codex session's palette
  // resolves to Codex's project skills rather than the inferred claude-code
  // default. Runtime + caps are resolved above (they also gate /compact dispatch).
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
    chatInputRef,
  });

  /** Re-send the last user message after an inline execution_error. */
  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg?.content) {
      submitContent(lastUserMsg.content);
    }
  }, [messages, submitContent]);

  /** Retry the last user message after a transport-level POST stream failure. */
  const handleTransportRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg?.content) {
      retryMessage(lastUserMsg.content);
    }
  }, [messages, retryMessage]);

  const showSuggestions = status === 'idle' && promptSuggestions.length > 0 && input.length === 0;

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

  return (
    <div data-testid="chat-panel" className="mx-auto flex h-full w-full max-w-7xl flex-col">
      <BirthCertificate sessionId={sessionId} />

      <ChatMessageArea
        messages={messages}
        sessionId={sessionId!}
        isLoadingHistory={isLoadingHistory}
        hydrated={hydrated}
        isTextStreaming={isTextStreaming}
        isAtBottom={isAtBottom}
        hasNewMessages={hasNewMessages}
        scrollToBottom={scrollToBottom}
        onScrollStateChange={handleScrollStateChange}
        activeToolCallId={activeInteraction?.toolCallId ?? null}
        onToolRef={handleToolRef}
        focusedOptionIndex={focusedOptionIndex}
        onToolDecided={markToolCallResponded}
        onRetry={handleRetry}
        inputZoneToolCallId={activeInteraction?.toolCallId ?? null}
        messageListRef={messageListRef}
      />

      <TerminalReasonChip terminalReason={sessionStatus?.terminalReason} />

      <ChatStatusStrip
        status={status}
        streamStartTime={streamStartTime}
        estimatedTokens={estimatedTokens}
        permissionMode={permissionMode}
        isWaitingForUser={isWaitingForUser ?? false}
        waitingType={waitingType ?? 'approval'}
        systemStatus={systemStatus}
        operationProgress={operationProgress}
      />

      <AnimatePresence>
        {showSuggestions && (
          <PromptSuggestionChips
            suggestions={promptSuggestions}
            onChipClick={handleSuggestionClick}
          />
        )}
      </AnimatePresence>

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
        submitContent={submitContent}
        tryNativeCommand={tryNativeCommand}
        status={status}
        sessionBusy={sessionBusy}
        stop={stop}
        setInput={setInput}
        sessionId={sessionId ?? ''}
        sessionStatus={sessionStatus}
        fileUpload={{
          pendingFiles: fileUpload.pendingFiles,
          onFilesSelected: fileUpload.addFiles,
          onFileRemove: fileUpload.removeFile,
          isUploading: fileUpload.isUploading,
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
  );
}

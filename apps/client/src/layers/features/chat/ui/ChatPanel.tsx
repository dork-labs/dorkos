import { useRef, useMemo, useCallback, useEffect } from 'react';
import { AnimatePresence } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { useChatSession } from '../model/use-chat-session';
import { useCommands } from '@/layers/entities/command';
import { useTaskState } from '../model/use-task-state';
import { useToolShortcuts } from '../model/use-tool-shortcuts';
import { useScrollOverlay } from '../model/use-scroll-overlay';
import { useInputAutocomplete } from '../model/use-input-autocomplete';
import { useChatStatusSync } from '../model/use-chat-status-sync';
import { useFileUpload } from '../model/use-file-upload';
import { buildFileEntries } from '../lib/build-file-entries';
import { useSessionId, useSessionStatus, useDirectoryState } from '@/layers/entities/session';
import { useAppStore } from '@/layers/shared/model';
import { playNotificationSound } from '@/layers/shared/lib';
import type { MessageListHandle } from './MessageList';
import type { ChatInputHandle } from './input/ChatInput';
import { ChatMessageArea } from './ChatMessageArea';
import { ChatInputContainer } from './input/ChatInputContainer';
import { TaskListPanel } from './tasks/TaskListPanel';
import { CelebrationOverlay } from './CelebrationOverlay';
import { useFiles } from '@/layers/features/files';
import { useCelebrations } from '../model/use-celebrations';
import { ErrorMessageBlock } from './message/ErrorMessageBlock';
import { ChatStatusStrip } from './status/ChatStatusStrip';
import { PromptSuggestionChips } from './input/PromptSuggestionChips';
import type { TaskUpdateEvent } from '@dorkos/shared/types';

interface ChatPanelProps {
  sessionId: string | null;
  /** Optional transform applied to message content before sending to server */
  transformContent?: (content: string) => string | Promise<string>;
}

/** Top-level chat view composing message list, input, task panel, and celebration effects. */
export function ChatPanel({ sessionId, transformContent }: ChatPanelProps) {
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
    sessionStatus,
    streamStartTime,
    estimatedTokens,
    isTextStreaming,
    isWaitingForUser,
    waitingType,
    activeInteraction,
    pendingInteractions,
    markToolCallResponded,
    isRateLimited,
    rateLimitRetryAfter,
    systemStatus,
    promptSuggestions,
    presenceInfo,
    presenceTasks,
    syncConnectionState,
    syncFailedAttempts,
    retryMessage,
  } = useChatSession(sessionId, {
    transformContent: fileTransformContent,
    onTaskEvent: handleTaskEventWithCelebrations,
    onSessionIdChange: handleSessionIdChange,
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

  const { data: registry } = useCommands(cwd);
  const allCommands = useMemo(() => registry?.commands ?? [], [registry]);
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

  const handleSuggestionClick = useCallback(
    (suggestion: string) => {
      setInput(suggestion);
      chatInputRef.current?.focus();
    },
    [setInput]
  );

  return (
    <div data-testid="chat-panel" className="mx-auto flex h-full w-full max-w-7xl flex-col">
      <ChatMessageArea
        messages={messages}
        sessionId={sessionId!}
        isLoadingHistory={isLoadingHistory}
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

      <ChatStatusStrip
        status={status}
        streamStartTime={streamStartTime}
        estimatedTokens={estimatedTokens}
        permissionMode={permissionMode}
        isWaitingForUser={isWaitingForUser ?? false}
        waitingType={waitingType ?? 'approval'}
        isRateLimited={isRateLimited ?? false}
        rateLimitRetryAfter={rateLimitRetryAfter ?? null}
        systemStatus={systemStatus}
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
          failedAttempts: syncFailedAttempts,
          presenceInfo,
          presenceTasks,
        }}
      />
    </div>
  );
}

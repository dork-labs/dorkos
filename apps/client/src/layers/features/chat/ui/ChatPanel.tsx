import { useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowDown } from 'lucide-react';
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
import { MessageList } from './MessageList';
import type { MessageListHandle } from './MessageList';
import type { ChatInputHandle } from './ChatInput';
import { ChatInputContainer } from './ChatInputContainer';
import { TaskListPanel } from './TaskListPanel';
import { CelebrationOverlay } from './CelebrationOverlay';
import { useFiles } from '@/layers/features/files';
import { useCelebrations } from '../model/use-celebrations';
import type { TaskUpdateEvent } from '@dorkos/shared/types';

interface ChatPanelProps {
  sessionId: string | null;
  /** Optional transform applied to message content before sending to server */
  transformContent?: (content: string) => string | Promise<string>;
}

export function ChatPanel({ sessionId, transformContent }: ChatPanelProps) {
  const [, setSessionId] = useSessionId();
  const messageListRef = useRef<MessageListHandle>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const taskState = useTaskState(sessionId ?? '');
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

  const {
    messages,
    input,
    setInput,
    handleSubmit,
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
    markToolCallResponded,
  } = useChatSession(sessionId, {
    transformContent: fileTransformContent,
    onTaskEvent: handleTaskEventWithCelebrations,
    onSessionIdChange: setSessionId,
    onStreamingDone: useCallback(() => {
      if (enableNotificationSound) {
        playNotificationSound();
      }
    }, [enableNotificationSound]),
  });
  const { permissionMode } = useSessionStatus(sessionId ?? '', sessionStatus, status === 'streaming');

  const { handleToolRef, focusedOptionIndex } = useToolShortcuts(activeInteraction);
  const { isAtBottom, hasNewMessages, scrollToBottom, handleScrollStateChange } =
    useScrollOverlay(messages, messageListRef);

  useChatStatusSync(status, isWaitingForUser, taskState.activeForm);

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

  return (
    <div data-testid="chat-panel" className="mx-auto flex h-full w-full max-w-7xl flex-col">
      <div className="relative min-h-0 flex-1">
        {isLoadingHistory ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <div className="flex gap-1">
                <span
                  className="bg-muted-foreground h-2 w-2 rounded-full"
                  style={{
                    animation: 'typing-dot 1.4s ease-in-out infinite',
                    animationDelay: '0s',
                  }}
                />
                <span
                  className="bg-muted-foreground h-2 w-2 rounded-full"
                  style={{
                    animation: 'typing-dot 1.4s ease-in-out infinite',
                    animationDelay: '0.2s',
                  }}
                />
                <span
                  className="bg-muted-foreground h-2 w-2 rounded-full"
                  style={{
                    animation: 'typing-dot 1.4s ease-in-out infinite',
                    animationDelay: '0.4s',
                  }}
                />
              </div>
              Loading conversation...
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-muted-foreground text-base">Start a conversation</p>
              <p className="text-muted-foreground/60 mt-2 text-sm">Type a message below to begin</p>
            </div>
          </div>
        ) : (
          <MessageList
            ref={messageListRef}
            messages={messages}
            sessionId={sessionId!}
            status={status}
            isTextStreaming={isTextStreaming}
            onScrollStateChange={handleScrollStateChange}
            streamStartTime={streamStartTime}
            estimatedTokens={estimatedTokens}
            permissionMode={permissionMode}
            isWaitingForUser={isWaitingForUser}
            waitingType={waitingType ?? undefined}
            activeToolCallId={activeInteraction?.toolCallId ?? null}
            onToolRef={handleToolRef}
            focusedOptionIndex={focusedOptionIndex}
            onToolDecided={markToolCallResponded}
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

      <CelebrationOverlay
        celebration={celebrations.activeCelebration}
        onComplete={celebrations.clearCelebration}
      />

      <TaskListPanel
        tasks={taskState.tasks}
        activeForm={taskState.activeForm}
        isCollapsed={taskState.isCollapsed}
        onToggleCollapse={taskState.toggleCollapse}
        celebratingTaskId={celebrations.celebratingTaskId}
        onCelebrationComplete={celebrations.clearCelebration}
      />

      {error && (
        <div className="mx-4 mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <ChatInputContainer
        chatInputRef={chatInputRef}
        input={input}
        autocomplete={autocomplete}
        handleSubmit={handleSubmit}
        status={status}
        sessionBusy={sessionBusy}
        stop={stop}
        setInput={setInput}
        sessionId={sessionId ?? ''}
        sessionStatus={sessionStatus}
        pendingFiles={fileUpload.pendingFiles}
        onFilesSelected={fileUpload.addFiles}
        onFileRemove={fileUpload.removeFile}
        isUploading={fileUpload.isUploading}
      />
    </div>
  );
}

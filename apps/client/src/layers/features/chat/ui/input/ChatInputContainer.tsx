import { useCallback, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { RefObject } from 'react';
import type { SessionStatusEvent } from '@dorkos/shared/types';
import { ChatInput } from './ChatInput';
import type { ChatInputHandle } from './ChatInput';
import { InteractiveInputPanel } from './InteractiveInputPanel';
import type {
  FileUploadProps,
  InteractionProps,
  SyncPresenceProps,
} from './chat-input-container-types';
import { ChatStatusSection } from '../status/ChatStatusSection';
import { BackgroundTaskBar } from '../tasks/BackgroundTaskBar';
import { useBackgroundTasks } from '../../model/use-background-tasks';
import { useChatQueue } from '../../model/use-chat-queue';
import { FileChipBar } from './FileChipBar';
import { QueuePanel } from './QueuePanel';
import { CommandPalette } from '@/layers/features/commands';
import { FilePalette } from '@/layers/features/files';
import { ScanLine } from '@/layers/shared/ui';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import {
  useDirectoryState,
  useSessionChatState,
  useSessionStreamState,
} from '@/layers/entities/session';
import { selectRenderedMessages } from '../../model/stream/derive-rendered-state';
import { useRotatingPlaceholder } from '../../model/use-rotating-placeholder';
import { AnimatedPlaceholder } from './AnimatedPlaceholder';
import placeholderHints from '../../config/placeholder-hints.json';
import type { useInputAutocomplete } from '../../model/use-input-autocomplete';
import { useDragAndPaste } from './use-drag-and-paste';

interface ChatInputContainerProps {
  chatInputRef: RefObject<ChatInputHandle | null>;
  input: string;
  autocomplete: ReturnType<typeof useInputAutocomplete>;
  handleSubmit: () => void;
  submitContent: (content: string, originSessionId?: string, opts?: { queued: boolean }) => void;
  status: 'idle' | 'streaming' | 'error';
  sessionBusy: boolean;
  stop: () => void;
  setInput: (value: string) => void;
  sessionId: string;
  sessionStatus: SessionStatusEvent | null;
  fileUpload: FileUploadProps;
  interaction: InteractionProps;
  sync: SyncPresenceProps;
}

function getPlaceholder(
  editingIndex: number | null,
  isStreaming: boolean,
  queueLength: number,
  defaultText: string
): string {
  if (editingIndex !== null) return '';
  if (isStreaming && queueLength > 0) return `Compose another \u2014 ${queueLength} queued`;
  if (isStreaming) return 'Compose next \u2014 will send when ready';
  return defaultText;
}

/** Container for chat input, autocomplete palettes, drag-and-drop, and status chips. */
export function ChatInputContainer({
  chatInputRef,
  input,
  autocomplete,
  handleSubmit,
  submitContent,
  status,
  sessionBusy,
  stop,
  setInput,
  sessionId,
  sessionStatus,
  fileUpload,
  interaction,
  sync,
}: ChatInputContainerProps) {
  const {
    active: activeInteraction,
    pendingApprovals,
    focusedOptionIndex,
    onToolRef,
    onToolDecided,
  } = interaction;
  const { pendingFiles, onFilesSelected, onFileRemove, isUploading } = fileUpload;
  const isStreaming = status === 'streaming';
  const isTextStreaming = useAppStore((s) => s.isTextStreaming);
  const [selectedCwd] = useDirectoryState();
  const transport = useTransport();
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const agentVisual = useAgentVisual(currentAgent ?? null, selectedCwd ?? '');
  const agentName = currentAgent ? getAgentDisplayName(currentAgent) : undefined;
  const defaultPlaceholder = agentName ? `Message ${agentName}...` : 'Send a message...';

  const chatQueue = useChatQueue({
    input,
    setInput,
    status,
    sessionBusy,
    sessionId,
    selectedCwd,
    onFlush: submitContent,
    chatInputRef,
  });

  // Background-task detection reads the hydrated stream-store projection (falling
  // back to the legacy send-path messages until the session hydrates) so it sees
  // the same list the chat renders (spec chat-stream-reconnection, Phase 3).
  const { messages: legacyMessages } = useSessionChatState(sessionId);
  const streamState = useSessionStreamState(sessionId);
  const messages = useMemo(
    () => selectRenderedMessages(streamState, legacyMessages),
    [streamState, legacyMessages]
  );
  const backgroundTasks = useBackgroundTasks(messages);

  const handleStopTask = useCallback(
    async (taskId: string) => {
      if (!sessionId) return;
      try {
        await transport.stopTask(sessionId, taskId);
      } catch (err) {
        console.error('[chat] Failed to stop task:', err);
      }
    },
    [sessionId, transport]
  );

  const isIdle = !isStreaming && chatQueue.editingIndex === null;
  const rotatingPlaceholder = useRotatingPlaceholder({
    defaultText: defaultPlaceholder,
    hints: placeholderHints,
    enabled: isIdle && input === '',
  });

  const { getRootProps, getInputProps, isDragActive, handlePaste } = useDragAndPaste({
    onFilesSelected,
  });

  return (
    <div
      {...getRootProps()}
      onPaste={handlePaste}
      className="chat-input-container bg-surface relative m-2 rounded-xl border p-2"
    >
      <input {...getInputProps()} />

      <AnimatePresence>
        {isStreaming && (
          <ScanLine color={agentVisual.color} isTextStreaming={isTextStreaming} edge="top" />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isDragActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="bg-primary/10 border-primary absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed"
          >
            <p className="text-primary text-sm font-medium">Drop files to attach</p>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {activeInteraction ? (
          <motion.div
            key="interactive"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <InteractiveInputPanel
              sessionId={sessionId}
              activeInteraction={activeInteraction}
              pendingApprovals={pendingApprovals}
              focusedOptionIndex={focusedOptionIndex}
              onToolRef={onToolRef}
              onToolDecided={onToolDecided}
            />
          </motion.div>
        ) : (
          <motion.div
            key="normal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className="absolute right-0 bottom-full left-0 mb-2">
              <AnimatePresence>
                {autocomplete.commands.show && (
                  <CommandPalette
                    filteredCommands={autocomplete.commands.filtered}
                    selectedIndex={autocomplete.commands.selectedIndex}
                    onSelect={autocomplete.handleCommandSelect}
                  />
                )}
                {autocomplete.files.show && (
                  <FilePalette
                    filteredFiles={autocomplete.files.filtered}
                    selectedIndex={autocomplete.files.selectedIndex}
                    onSelect={autocomplete.handleFileSelect}
                  />
                )}
              </AnimatePresence>
            </div>

            {pendingFiles.length > 0 && (
              <FileChipBar files={pendingFiles} onRemove={onFileRemove} />
            )}
            <QueuePanel
              queue={chatQueue.queue}
              editingIndex={chatQueue.editingIndex}
              onEdit={chatQueue.handleQueueEdit}
              onRemove={chatQueue.handleQueueRemove}
            />
            <BackgroundTaskBar tasks={backgroundTasks} onStopTask={handleStopTask} />

            <ChatInput
              ref={chatInputRef}
              value={input}
              onChange={autocomplete.handleInputChange}
              onSubmit={handleSubmit}
              isStreaming={isStreaming}
              isUploading={isUploading}
              sessionBusy={sessionBusy}
              onStop={stop}
              onEscape={autocomplete.dismissPalettes}
              onClear={() => {
                setInput('');
                autocomplete.dismissPalettes();
              }}
              isPaletteOpen={autocomplete.isPaletteOpen}
              onArrowUp={autocomplete.handleArrowUp}
              onArrowDown={autocomplete.handleArrowDown}
              onCommandSelect={autocomplete.handleKeyboardSelect}
              activeDescendantId={autocomplete.activeDescendantId}
              onCursorChange={autocomplete.handleCursorChange}
              onAttach={onFilesSelected}
              editingQueueItem={chatQueue.editingIndex !== null}
              queueDepth={chatQueue.queue.length}
              onQueue={chatQueue.handleQueue}
              onSaveEdit={chatQueue.handleQueueSaveEdit}
              onCancelEdit={chatQueue.handleQueueCancelEdit}
              onQueueNavigateUp={chatQueue.handleQueueNavigateUp}
              onQueueNavigateDown={chatQueue.handleQueueNavigateDown}
              queueHasItems={chatQueue.queue.length > 0}
              placeholder={getPlaceholder(
                chatQueue.editingIndex,
                isStreaming,
                chatQueue.queue.length,
                defaultPlaceholder
              )}
              placeholderOverlay={
                isIdle ? (
                  <AnimatedPlaceholder
                    text={rotatingPlaceholder.text}
                    animationKey={rotatingPlaceholder.key}
                  />
                ) : null
              }
            />

            <ChatStatusSection
              sessionId={sessionId}
              sessionStatus={sessionStatus}
              isStreaming={isStreaming}
              onChipClick={autocomplete.handleChipClick}
              syncConnectionState={sync.connectionState}
              agentName={agentName}
              agentColor={agentVisual.color}
              agentEmoji={agentVisual.emoji}
              agentPath={selectedCwd ?? undefined}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

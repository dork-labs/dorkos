import { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useDropzone } from 'react-dropzone';
import type { RefObject } from 'react';
import type {
  SessionStatusEvent,
  PresenceUpdateEvent,
  ConnectionState,
} from '@dorkos/shared/types';
import type { ToolCallState } from '../../model/chat-types';
import { ChatInput } from './ChatInput';
import type { ChatInputHandle } from './ChatInput';
import { ChatStatusSection } from '../status/ChatStatusSection';
import { BackgroundTaskBar } from '../tasks/BackgroundTaskBar';
import { useBackgroundTasks } from '../../model/use-background-tasks';
import { useChatQueue } from '../../model/use-chat-queue';
import { FileChipBar } from './FileChipBar';
import { QueuePanel } from './QueuePanel';
import { ToolApproval } from '../tools/ToolApproval';
import { BatchApprovalBar } from '../tools/BatchApprovalBar';
import { QuestionPrompt } from '../tools/QuestionPrompt';
import { CommandPalette } from '@/layers/features/commands';
import { FilePalette } from '@/layers/features/files';
import { ScanLine } from '@/layers/shared/ui';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { useDirectoryState, useSessionChatState } from '@/layers/entities/session';
import type { InteractiveToolHandle } from '../message';
import { useRotatingPlaceholder } from '../../model/use-rotating-placeholder';
import { AnimatedPlaceholder } from './AnimatedPlaceholder';
import placeholderHints from '../../config/placeholder-hints.json';
import type { useInputAutocomplete } from '../../model/use-input-autocomplete';
import type { PendingFile } from '../../model/use-file-upload';

/** File upload state passed from the parent. */
interface FileUploadProps {
  pendingFiles: PendingFile[];
  onFilesSelected: (files: File[]) => void;
  onFileRemove: (id: string) => void;
  isUploading: boolean;
}

/** Interactive tool state shared between the message list and input zone. */
interface InteractionProps {
  active: ToolCallState | null;
  /** All pending interactive tool calls (for batch approve/deny). */
  pendingApprovals: ToolCallState[];
  focusedOptionIndex: number;
  onToolRef: (handle: InteractiveToolHandle | null) => void;
  onToolDecided: (toolCallId: string) => void;
}

/** Cross-client sync and presence state for status indicators. */
interface SyncPresenceProps {
  connectionState: ConnectionState;
  failedAttempts: number;
  presenceInfo: PresenceUpdateEvent | null;
  presenceTasks: boolean;
}

interface ChatInputContainerProps {
  chatInputRef: RefObject<ChatInputHandle | null>;
  input: string;
  autocomplete: ReturnType<typeof useInputAutocomplete>;
  handleSubmit: () => void;
  /** Send explicit content (used by message queue auto-flush). */
  submitContent: (content: string) => void;
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
  const mode = activeInteraction ? 'interactive' : 'normal';
  const isStreaming = status === 'streaming';
  const isTextStreaming = useAppStore((s) => s.isTextStreaming);
  const [selectedCwd] = useDirectoryState();
  const transport = useTransport();
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const agentVisual = useAgentVisual(currentAgent ?? null, selectedCwd ?? '');
  const agentName = currentAgent ? getAgentDisplayName(currentAgent) : undefined;
  const defaultPlaceholder = agentName ? `Message ${agentName}...` : 'Send a message...';

  // --- Queue management (owned here, not passed from ChatPanel) ---
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

  // --- Background tasks (derived from messages in the session store) ---
  const { messages } = useSessionChatState(sessionId);
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

  // Preserve draft text when switching to interactive mode
  const interactiveDraftRef = useRef('');

  useEffect(() => {
    if (activeInteraction) {
      interactiveDraftRef.current = input;
    }
    // Only trigger when the active tool call changes, not on every input keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInteraction?.toolCallId]);

  useEffect(() => {
    if (!activeInteraction && interactiveDraftRef.current) {
      setInput(interactiveDraftRef.current);
      interactiveDraftRef.current = '';
      // Focus is handled by ChatInput's mount effect — it auto-focuses when
      // AnimatePresence finishes the interactive→normal transition and mounts it.
    }
  }, [activeInteraction, setInput]);

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        onFilesSelected(acceptedFiles);
      }
    },
    [onFilesSelected]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
  });

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const items = Array.from(e.clipboardData.items);
      const files = items
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length > 0) {
        onFilesSelected(files);
      }
    },
    [onFilesSelected]
  );

  return (
    <div
      {...getRootProps()}
      onPaste={handlePaste}
      className="chat-input-container bg-surface relative m-2 rounded-xl border p-2"
    >
      {/* Hidden dropzone input — react-dropzone requires this */}
      <input {...getInputProps()} />

      {/* Streaming scan line — sweeps across input container top edge */}
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

      {/* Inner content crossfade between normal and interactive modes */}
      <AnimatePresence mode="wait">
        {mode === 'interactive' ? (
          <motion.div
            key="interactive"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <BatchApprovalBar sessionId={sessionId} pendingApprovals={pendingApprovals} />
            {activeInteraction!.interactiveType === 'approval' ? (
              <ToolApproval
                ref={onToolRef}
                sessionId={sessionId}
                toolCallId={activeInteraction!.toolCallId}
                toolName={activeInteraction!.toolName}
                input={activeInteraction!.input || ''}
                isActive
                onDecided={
                  onToolDecided ? () => onToolDecided(activeInteraction!.toolCallId) : undefined
                }
                timeoutMs={activeInteraction!.timeoutMs}
                approvalStartedAt={activeInteraction!.approvalStartedAt}
                approvalTitle={activeInteraction!.approvalTitle}
                approvalDisplayName={activeInteraction!.approvalDisplayName}
                approvalDescription={activeInteraction!.approvalDescription}
                approvalBlockedPath={activeInteraction!.approvalBlockedPath}
                approvalDecisionReason={activeInteraction!.approvalDecisionReason}
                approvalHasSuggestions={activeInteraction!.approvalHasSuggestions}
              />
            ) : activeInteraction!.interactiveType === 'question' &&
              activeInteraction!.questions ? (
              <QuestionPrompt
                ref={onToolRef}
                sessionId={sessionId}
                toolCallId={activeInteraction!.toolCallId}
                questions={activeInteraction!.questions}
                answers={activeInteraction!.answers}
                isActive
                focusedOptionIndex={focusedOptionIndex}
                onDecided={
                  onToolDecided ? () => onToolDecided(activeInteraction!.toolCallId) : undefined
                }
              />
            ) : null}
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
              isStreaming={status === 'streaming'}
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
              placeholder={(() => {
                if (chatQueue.editingIndex !== null) return '';
                if (isStreaming && chatQueue.queue.length > 0)
                  return `Compose another \u2014 ${chatQueue.queue.length} queued`;
                if (isStreaming) return 'Compose next \u2014 will send when ready';
                return defaultPlaceholder;
              })()}
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
              isStreaming={status === 'streaming'}
              onChipClick={autocomplete.handleChipClick}
              presenceInfo={sync.presenceInfo}
              presenceTasks={sync.presenceTasks}
              syncConnectionState={sync.connectionState}
              syncFailedAttempts={sync.failedAttempts}
              agentName={agentName}
              agentColor={agentVisual.color}
              agentEmoji={agentVisual.emoji}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

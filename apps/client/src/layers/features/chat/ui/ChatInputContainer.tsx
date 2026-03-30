import { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useDropzone } from 'react-dropzone';
import type { RefObject } from 'react';
import type {
  SessionStatusEvent,
  PresenceUpdateEvent,
  ConnectionState,
} from '@dorkos/shared/types';
import type { ToolCallState } from '../model/chat-types';
import { ChatInput } from './ChatInput';
import type { ChatInputHandle } from './ChatInput';
import { ChatStatusSection } from './ChatStatusSection';
import { BackgroundTaskBar } from './BackgroundTaskBar';
import type { VisibleBackgroundTask } from '../model/use-background-tasks';
import { FileChipBar } from './FileChipBar';
import { QueuePanel } from './QueuePanel';
import { ToolApproval } from './ToolApproval';
import { QuestionPrompt } from './QuestionPrompt';
import { CommandPalette } from '@/layers/features/commands';
import { FilePalette } from '@/layers/features/files';
import { ScanLine } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { useDirectoryState } from '@/layers/entities/session';
import type { InteractiveToolHandle } from './message';
import { useRotatingPlaceholder } from '../model/use-rotating-placeholder';
import { AnimatedPlaceholder } from './AnimatedPlaceholder';
import placeholderHints from '../config/placeholder-hints.json';
import type { useInputAutocomplete } from '../model/use-input-autocomplete';
import type { PendingFile } from '../model/use-file-upload';
import type { QueueItem } from '../model/use-message-queue';

interface ChatInputContainerProps {
  chatInputRef: RefObject<ChatInputHandle | null>;
  input: string;
  autocomplete: ReturnType<typeof useInputAutocomplete>;
  handleSubmit: () => void;
  status: 'idle' | 'streaming' | 'error';
  sessionBusy: boolean;
  stop: () => void;
  setInput: (value: string) => void;
  sessionId: string;
  sessionStatus: SessionStatusEvent | null;
  /** Files staged for upload. */
  pendingFiles: PendingFile[];
  /** Called when new files are selected via drop, paste, or the paperclip button. */
  onFilesSelected: (files: File[]) => void;
  /** Called when a pending file chip is dismissed. */
  onFileRemove: (id: string) => void;
  /** Whether an upload batch is in flight. */
  isUploading: boolean;
  /** Current message queue contents. */
  queue: QueueItem[];
  /** Index of the queue item being edited, or null. */
  editingIndex: number | null;
  /** Queue the current input for later sending. */
  onQueue: () => void;
  /** Remove a queue item by index. */
  onQueueRemove: (index: number) => void;
  /** Load a queue item into the textarea for editing. */
  onQueueEdit: (index: number) => void;
  /** Save the currently edited queue item. */
  onQueueSaveEdit: () => void;
  /** Cancel editing the current queue item. */
  onQueueCancelEdit: () => void;
  /** Navigate up through the queue (shell-history style). */
  onQueueNavigateUp: () => void;
  /** Navigate down through the queue (shell-history style). */
  onQueueNavigateDown: () => void;
  /** Current presence info from SSE. */
  presenceInfo: PresenceUpdateEvent | null;
  /** Whether the presence badge should tasks. */
  presenceTasks: boolean;
  /** The currently active interactive tool awaiting user input, or null. */
  activeInteraction: ToolCallState | null;
  /** Index of the currently keyboard-focused option (question prompts). */
  focusedOptionIndex: number;
  /** Ref callback to attach to the interactive tool's imperative handle. */
  onToolRef: (handle: InteractiveToolHandle | null) => void;
  /** Called after the user approves/denies/submits to clear waiting state. */
  onToolDecided: (toolCallId: string) => void;
  /** Background tasks to display in the task bar. */
  backgroundTasks: VisibleBackgroundTask[];
  /** Callback to stop a running background task. */
  onStopTask: (taskId: string) => void;
  /** SSE sync connection state for the ConnectionItem indicator. */
  syncConnectionState: ConnectionState;
  /** Number of failed reconnection attempts. */
  syncFailedAttempts: number;
}

/** Container for chat input, autocomplete palettes, drag-and-drop, and status chips. */
export function ChatInputContainer({
  chatInputRef,
  input,
  autocomplete,
  handleSubmit,
  status,
  sessionBusy,
  stop,
  setInput,
  sessionId,
  sessionStatus,
  pendingFiles,
  onFilesSelected,
  onFileRemove,
  isUploading,
  queue,
  editingIndex,
  onQueue,
  onQueueRemove,
  onQueueEdit,
  onQueueSaveEdit,
  onQueueCancelEdit,
  onQueueNavigateUp,
  onQueueNavigateDown,
  presenceInfo,
  presenceTasks,
  activeInteraction,
  focusedOptionIndex,
  onToolRef,
  onToolDecided,
  backgroundTasks,
  onStopTask,
  syncConnectionState,
  syncFailedAttempts,
}: ChatInputContainerProps) {
  const mode = activeInteraction ? 'interactive' : 'normal';
  const isStreaming = status === 'streaming';
  const isIdle = !isStreaming && editingIndex === null;
  const isTextStreaming = useAppStore((s) => s.isTextStreaming);
  const [selectedCwd] = useDirectoryState();
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const agentVisual = useAgentVisual(currentAgent ?? null, selectedCwd ?? '');
  const agentName = currentAgent?.name;
  const defaultPlaceholder = agentName ? `Message ${agentName}...` : 'Send a message...';
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
      chatInputRef.current?.focus();
    }
  }, [activeInteraction, setInput, chatInputRef]);

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

            {pendingFiles.length > 0 && (
              <FileChipBar files={pendingFiles} onRemove={onFileRemove} />
            )}

            <QueuePanel
              queue={queue}
              editingIndex={editingIndex}
              onEdit={onQueueEdit}
              onRemove={onQueueRemove}
            />

            <BackgroundTaskBar tasks={backgroundTasks} onStopTask={onStopTask} />

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
              editingQueueItem={editingIndex !== null}
              queueDepth={queue.length}
              onQueue={onQueue}
              onSaveEdit={onQueueSaveEdit}
              onCancelEdit={onQueueCancelEdit}
              onQueueNavigateUp={onQueueNavigateUp}
              onQueueNavigateDown={onQueueNavigateDown}
              queueHasItems={queue.length > 0}
              placeholder={(() => {
                if (editingIndex !== null) return '';
                if (isStreaming && queue.length > 0)
                  return `Compose another \u2014 ${queue.length} queued`;
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
              presenceInfo={presenceInfo}
              presenceTasks={presenceTasks}
              syncConnectionState={syncConnectionState}
              syncFailedAttempts={syncFailedAttempts}
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

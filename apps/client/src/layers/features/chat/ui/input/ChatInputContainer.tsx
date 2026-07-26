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
import type { NativeCommandResult } from '../../model/native-commands';
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
  submitContent: (
    content: string,
    originSessionId?: string,
    opts?: { queued: boolean; restore?: () => void }
  ) => void;
  /**
   * Native (client-side) command interceptor. Used at the queue decision so a
   * native command typed while a turn streams runs instantly instead of being
   * queued (a queued native command never starts a turn and would stall the pump).
   */
  tryNativeCommand: (content: string) => NativeCommandResult;
  /**
   * A dispatched native command has not settled yet. Closes both submit paths
   * for that window — the composer keeps the command's text until it confirms,
   * so nothing else stops a second Enter re-dispatching it.
   */
  commandPending: boolean;
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

/**
 * The composer's label \u2014 its `aria-label`, and its visible placeholder whenever
 * the rotating overlay is not covering it.
 *
 * Editing a queued item used to return `''`, so in the one mode where the
 * field's behavior changes \u2014 Enter saves instead of sends \u2014 it announced
 * nothing at all. It carries the item's text, so no visible placeholder is lost
 * by naming it properly.
 */
function getPlaceholder(
  editingIndex: number | null,
  isStreaming: boolean,
  queueLength: number,
  defaultText: string
): string {
  if (editingIndex !== null) {
    return `Edit queued message ${editingIndex + 1} of ${queueLength} \u2014 press Enter to save`;
  }
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
  tryNativeCommand,
  commandPending,
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
  const { pendingFiles, onFilesSelected, onFileRemove, onFileRetry, isUploading, hasFailedUpload } =
    fileUpload;
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
    tryNativeCommand,
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

  // Sending closes the palettes. It used to happen by accident: an open palette
  // swallowed Enter, and `onCommandSelect` found no row and closed the panel on
  // its way out. Now that Enter falls through to the send when there is nothing
  // to pick, nothing else would take the "No commands found." card down —
  // `detectTrigger` only runs on typing or a caret move — so it would float
  // over the agent's reply until the next keystroke.
  const submitAndDismiss = useCallback(() => {
    autocomplete.dismissPalettes();
    handleSubmit();
  }, [autocomplete, handleSubmit]);

  const queueAndDismiss = useCallback(() => {
    autocomplete.dismissPalettes();
    chatQueue.handleQueue();
  }, [autocomplete, chatQueue]);

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
              // The queue panel is unmounted for the whole time a card is up
              // (this branch replaces the entire composer), so the only mark
              // that queued messages still exist would vanish at exactly the
              // moment it reassures. The messages survive — say so.
              queueDepth={chatQueue.queue.length}
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
              <FileChipBar files={pendingFiles} onRemove={onFileRemove} onRetry={onFileRetry} />
            )}
            {/* The presence guard lives here, not inside the panel: a component
                that returns null is still mounted, so AnimatePresence never saw
                it leave and the panel's exit animation never ran — it popped out
                at the exact moment the last queued message flushed. */}
            <AnimatePresence>
              {chatQueue.queue.length > 0 && (
                <QueuePanel
                  queue={chatQueue.queue}
                  editingId={chatQueue.editingId}
                  onEdit={chatQueue.handleQueueEdit}
                  onRemove={chatQueue.handleQueueRemove}
                  onSend={chatQueue.handleQueueSend}
                  // A failed attachment blocks a hand-send exactly as it blocks a
                  // normal one — and says so, instead of letting the click dequeue,
                  // fail inside the upload, and land as a generic "Could not send
                  // message". This component is the one place that holds both the
                  // queue and the attachment state.
                  sendBlockedReason={
                    hasFailedUpload ? 'An attachment did not upload' : chatQueue.sendBlockedReason
                  }
                />
              )}
            </AnimatePresence>
            <BackgroundTaskBar tasks={backgroundTasks} onStopTask={handleStopTask} />

            <ChatInput
              ref={chatInputRef}
              value={input}
              onChange={autocomplete.handleInputChange}
              onSubmit={submitAndDismiss}
              isStreaming={isStreaming}
              isUploading={isUploading}
              commandPending={commandPending}
              sessionBusy={sessionBusy}
              onStop={stop}
              onEscape={autocomplete.dismissPalettes}
              onClear={() => {
                setInput('');
                autocomplete.dismissPalettes();
              }}
              isPaletteOpen={autocomplete.isPaletteOpen}
              paletteHasResults={autocomplete.paletteHasResults}
              onArrowUp={autocomplete.handleArrowUp}
              onArrowDown={autocomplete.handleArrowDown}
              onCommandSelect={autocomplete.handleKeyboardSelect}
              activeDescendantId={autocomplete.activeDescendantId}
              paletteListboxId={autocomplete.paletteListboxId}
              onCursorChange={autocomplete.handleCursorChange}
              onAttach={onFilesSelected}
              // A failed attachment blocks the send outright. Sending anyway
              // delivered a message with no attachment and then wiped the error
              // chips, leaving the person waiting on an answer about a file the
              // agent never received (DOR-480). The red chip above states the
              // reason and offers both ways out — try again, or remove it.
              canSubmit={!hasFailedUpload}
              editingQueueItem={chatQueue.editingIndex !== null}
              editingPosition={
                chatQueue.editingIndex === null ? undefined : chatQueue.editingIndex + 1
              }
              queueDepth={chatQueue.queue.length}
              onQueue={queueAndDismiss}
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

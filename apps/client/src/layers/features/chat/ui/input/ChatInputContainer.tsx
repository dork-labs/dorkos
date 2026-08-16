import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { RefObject } from 'react';
import type { SessionStatusEvent } from '@dorkos/shared/types';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { Composer, type ComposerInputHandle } from '@/layers/features/composer';
import { InteractiveInputPanel } from './InteractiveInputPanel';
import { StopConfirmDialog } from './StopConfirmDialog';
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
import { QueuePanel } from './QueuePanel';
import { CommandPalette } from '@/layers/features/commands';
import { FilePalette } from '@/layers/features/files';
import { ScanLine } from '@/layers/shared/ui';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { useComposerRichText } from '@/layers/entities/config';
import {
  composerFileReference,
  getAgentDisplayName,
  registerComposerInsert,
} from '@/layers/shared/lib';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import {
  useDirectoryState,
  useSessionAwaitingDecision,
  useSessionChatState,
  useSessionChatStore,
  useSessionQueue,
  useSessionRuntime,
  useSessionStreamLifecycle,
  useSessionStreamState,
} from '@/layers/entities/session';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { selectRenderedMessages } from '../../model/stream/derive-rendered-state';
import { useRotatingPlaceholder } from '../../model/use-rotating-placeholder';
import { AnimatedPlaceholder } from './AnimatedPlaceholder';
import placeholderHints from '../../config/placeholder-hints.json';
import type { useInputAutocomplete } from '../../model/use-input-autocomplete';
import { sessionContextKey } from '../../lib/session-context-key';
import { selectWaitingQueue } from '../../lib/queue-chips';

interface ChatInputContainerProps {
  chatInputRef: RefObject<ComposerInputHandle | null>;
  input: string;
  autocomplete: ReturnType<typeof useInputAutocomplete>;
  handleSubmit: () => void;
  /**
   * Put the composer's text on the session's server-owned queue. Resolves
   * `true` once the server has it, which is what lets the composer hold the
   * words until then.
   */
  enqueueContent: (content: string) => Promise<boolean>;
  /**
   * Send the composer's text into the running turn now (steer). Wired to the
   * Steer affordance only when the session's runtime declares it can take a
   * message mid-task; the affordance is hidden otherwise. Resolves `true` once
   * the server has it, exactly like {@link enqueueContent}.
   */
  steerContent: (content: string) => Promise<boolean>;
  /**
   * Add the composer's text as context the agent uses next, without cutting into
   * the running turn (stage). Wired to the Add context affordance only when the
   * runtime declares it can take added context.
   */
  addContextContent: (content: string) => Promise<boolean>;
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
  /**
   * Interrupt the running turn and empty its queue. Resolves with the messages
   * the server took off the queue, head first, so this window can return the
   * words to the composer.
   */
  stop: () => Promise<QueuedMessage[]>;
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
  enqueueContent,
  steerContent,
  addContextContent,
  tryNativeCommand,
  commandPending,
  status,
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
  const {
    pendingFiles,
    onFilesSelected,
    onFileRemove,
    onFileRetry,
    onUploadCancel,
    isUploading,
    hasFailedUpload,
  } = fileUpload;
  const isStreaming = status === 'streaming';
  const isTextStreaming = useAppStore((s) => s.isTextStreaming);
  const [selectedCwd] = useDirectoryState();
  const transport = useTransport();
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const agentVisual = useAgentVisual(currentAgent ?? null, selectedCwd ?? '');
  const agentName = currentAgent ? getAgentDisplayName(currentAgent) : undefined;
  const defaultPlaceholder = agentName ? `Message ${agentName}...` : 'Send a message...';

  // The queue lives on the server; this window reads it out of the session
  // projection and narrows it to the messages that are genuinely waiting.
  const serverQueue = useSessionQueue(sessionId);
  const lifecycle = useSessionStreamLifecycle(sessionId);
  const awaitingDecision = useSessionAwaitingDecision(sessionId);
  const waiting = useMemo(
    () => selectWaitingQueue(serverQueue, lifecycle),
    [serverQueue, lifecycle]
  );

  // What THIS session's runtime can do with a message sent mid-task. Steer and
  // Add context appear only when the runtime declares them (claude-code does,
  // codex and opencode do not) — a hidden choice is honest, a dead one is not.
  // A pure map lookup over the static capabilities, keyed by the session's
  // resolved runtime; `undefined` while it loads leaves both off, which is the
  // safe default.
  const sessionRuntime = useSessionRuntime(sessionId);
  const capabilities = useCapabilitiesForRuntime(sessionRuntime);
  const canSteer = capabilities?.supportsSteer ?? false;
  const canAddContext = capabilities?.supportsContextStaging ?? false;

  const chatQueue = useChatQueue({
    input,
    setInput,
    sessionId,
    selectedCwd,
    waiting,
    onEnqueue: enqueueContent,
    onSteer: steerContent,
    onStage: addContextContent,
    tryNativeCommand,
    chatInputRef,
  });

  // Stop means stop everything queued. When messages are waiting, the person is
  // asked first and told the cost, because a Stop that silently emptied a queue
  // would be a surprise; a Stop with nothing waiting behaves exactly as before,
  // with no dialog. The words the server hands back land in the composer draft,
  // after anything already typed, so nothing is lost.
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const restoreToComposer = useCallback(
    (returned: QueuedMessage[]) => {
      if (returned.length === 0) return;
      const restored = returned.map((m) => m.content).join('\n\n');
      // Read the composer's CURRENT text from the store, not a snapshot captured
      // before the interrupt round-trip — a person may have typed while Stop was
      // in flight, and appending to a stale value would drop what they just typed.
      const existing = useSessionChatStore.getState().getSession(sessionId).input.trim();
      setInput(existing ? `${existing}\n\n${restored}` : restored);
    },
    [sessionId, setInput]
  );
  const handleStop = useCallback(() => {
    if (waiting.length === 0) {
      void stop();
      return;
    }
    setStopConfirmOpen(true);
  }, [waiting.length, stop]);
  const confirmStop = useCallback(() => {
    setStopConfirmOpen(false);
    void stop().then(restoreToComposer);
  }, [stop, restoreToComposer]);

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

  // Text arriving from outside the composer — "Add to Chat" in the file
  // explorer, or a file dragged onto the box — is appended to whatever is
  // already typed, with the caret left after it. The current text is read
  // through a ref so the registration survives every keystroke instead of
  // re-running on each render.
  const latestInputRef = useRef(input);
  useEffect(() => {
    latestInputRef.current = input;
  });
  const insertIntoComposer = useCallback(
    (text: string) => {
      const current = latestInputRef.current;
      const separator = current.length > 0 && !/\s$/.test(current) ? ' ' : '';
      const next = `${current}${separator}${text}`;
      setInput(next);
      chatInputRef.current?.focusAt(next.length);
    },
    [setInput, chatInputRef]
  );
  // The file explorer reaches this through `shared/lib/composer-insert`, since
  // one feature may not import another's model.
  useEffect(() => registerComposerInsert(insertIntoComposer), [insertIntoComposer]);

  const isIdle = !isStreaming && chatQueue.editingIndex === null;
  const rotatingPlaceholder = useRotatingPlaceholder({
    defaultText: defaultPlaceholder,
    hints: placeholderHints,
    enabled: isIdle && input === '',
  });

  // The composer owns WHEN the double-Escape is armed (it owns the keyboard);
  // this component owns WHERE that reads out, because the lane it belongs in
  // floats above the queue panel and the attachment chips, which are rendered
  // here.
  const [clearArmed, setClearArmed] = useState(false);

  // Whether the message box formats as you type (`ui.composer.richText`,
  // DOR-948). `false` until config loads, so the box is briefly plain rather
  // than briefly the wrong field.
  const richText = useComposerRichText();

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

  const steerAndDismiss = useCallback(() => {
    autocomplete.dismissPalettes();
    chatQueue.handleSteer();
  }, [autocomplete, chatQueue]);

  const addContextAndDismiss = useCallback(() => {
    autocomplete.dismissPalettes();
    chatQueue.handleStage();
  }, [autocomplete, chatQueue]);

  return (
    // `chat-input-container` is not decoration: it is the hook for the
    // safe-area rule in `index.css`, and it rides on the card element itself.
    // Root never bakes it in — chat passes it, because chat is the only surface
    // that sits against the bottom of a notched screen.
    <Composer.Root
      className="chat-input-container"
      onFilesDropped={onFilesSelected}
      // A file dragged out of the Files panel is already on this machine, so it
      // becomes a reference in the message rather than an upload.
      onPathDropped={(path) => insertIntoComposer(composerFileReference(path))}
    >
      {/* Chat-only, so it arrives as a child rather than living in Root. */}
      <AnimatePresence>
        {isStreaming && (
          <ScanLine color={agentVisual.color} isTextStreaming={isTextStreaming} edge="top" />
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
            {/* Stacking is child order: palettes first, the armed-clear hint
                last, so the hint never lands on the queue rows' controls. */}
            <Composer.OverlayLane>
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
              {clearArmed && <Composer.ClearArmedHint />}
            </Composer.OverlayLane>

            {pendingFiles.length > 0 && (
              <Composer.Attachments
                files={pendingFiles}
                onRemove={onFileRemove}
                onRetry={onFileRetry}
                onCancel={onUploadCancel}
              />
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
                  onMoveUp={chatQueue.handleQueueMoveUp}
                  // The server dispatches the head the moment the session frees
                  // up, so the only thing that genuinely holds the line is the
                  // agent parked on a person — which it will not leave until
                  // that question is answered.
                  statusNote={
                    awaitingDecision
                      ? 'Waiting for your answer above'
                      : 'Sending one at a time as the agent finishes'
                  }
                />
              )}
            </AnimatePresence>
            <BackgroundTaskBar tasks={backgroundTasks} onStopTask={handleStopTask} />

            <Composer.Input
              ref={chatInputRef}
              value={input}
              onChange={autocomplete.handleInputChange}
              onSubmit={submitAndDismiss}
              isStreaming={isStreaming}
              isUploading={isUploading}
              onCancelUpload={onUploadCancel}
              commandPending={commandPending}
              onStop={handleStop}
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
              // Chat is the only surface that reads this, and passing it HERE
              // rather than defaulting it inside `Composer.Input` is what keeps
              // that true: rooms, the dashboard and onboarding pass nothing, so
              // they stay plain until they graduate. Which surface has
              // formatting is visible in the JSX, exactly as
              // `features/composer`'s barrel doctrine asks.
              richText={richText}
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
              // Present ONLY when the runtime can honour them, so the composer
              // hides Steer / Add context (never greys them) on a runtime that
              // can only queue. Presence of the callback IS the capability.
              onSteer={canSteer ? steerAndDismiss : undefined}
              onStage={canAddContext ? addContextAndDismiss : undefined}
              onSaveEdit={chatQueue.handleQueueSaveEdit}
              onCancelEdit={chatQueue.handleQueueCancelEdit}
              onQueueNavigateUp={chatQueue.handleQueueNavigateUp}
              onQueueNavigateDown={chatQueue.handleQueueNavigateDown}
              queueHasItems={chatQueue.queue.length > 0}
              // The SAME key the queue and the parked draft are scoped by, so a
              // pending double-Escape dies on exactly the boundary its draft
              // does. This composer is re-rendered rather than remounted on a
              // session switch, so an arm would otherwise survive into the next
              // session's text.
              contextKey={sessionContextKey(sessionId, selectedCwd) ?? undefined}
              onClearArmedChange={setClearArmed}
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
      <StopConfirmDialog
        open={stopConfirmOpen}
        onOpenChange={setStopConfirmOpen}
        queuedCount={waiting.length}
        onConfirm={confirmStop}
      />
    </Composer.Root>
  );
}

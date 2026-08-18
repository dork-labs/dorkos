/**
 * The session's wiring for `Conversation.Composer`.
 *
 * What is left of the retired `ChatInputContainer` once the card itself is
 * shared: which palettes this surface opens, what Enter means to it while a
 * turn is running, what Stop costs, and what the status line under the box
 * says. The card's SHAPE — the overlay lane, the chip bar, the queue chrome,
 * the field, the honest disabled state — is `Conversation.Composer`, and a
 * channel's composer is the same code.
 *
 * @module widgets/session/ui/SessionComposer
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import type { RefObject } from 'react';
import type { SessionStatusEvent } from '@dorkos/shared/types';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import type { ComposerInputHandle } from '@/layers/features/composer';
import { Conversation, useConversation } from '@/layers/features/conversation';
import { SessionAsks } from './SessionAsks';
import {
  BackgroundTaskBar,
  ChatStatusSection,
  QueuePanel,
  StopConfirmDialog,
  AnimatedPlaceholder,
  placeholderHints,
  selectRenderedMessages,
  sessionContextKey,
  useBackgroundTasks,
  useChatQueue,
  useRotatingPlaceholder,
  type NativeCommandResult,
  type InteractionProps,
  type SyncPresenceProps,
  type useInputAutocomplete,
} from '@/layers/features/chat';
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
  useSessionRuntime,
  useSessionSteerable,
  useSessionStreamState,
} from '@/layers/entities/session';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';

interface SessionComposerProps {
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
  /**
   * The server-held queue, narrowed to the messages genuinely WAITING.
   *
   * Passed in rather than read here because the host already reads it: the same
   * number drives the lane's "1 queued" rung through the target, and one fact
   * has one source.
   */
  waiting: QueuedMessage[];
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

/**
 * Draw the session's composer.
 *
 * @param props - The draft, the send funnel, and everything a session's field
 *   decides that a channel's does not.
 */
export function SessionComposer({
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
  waiting,
  interaction,
  sync,
}: SessionComposerProps) {
  const {
    active: activeInteraction,
    pendingApprovals,
    focusedOptionIndex,
    onToolRef,
    onToolDecided,
  } = interaction;
  const isStreaming = status === 'streaming';
  const isTextStreaming = useAppStore((s) => s.isTextStreaming);
  const [selectedCwd] = useDirectoryState();
  const transport = useTransport();
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const agentVisual = useAgentVisual(currentAgent ?? null, selectedCwd ?? '');
  const agentName = currentAgent ? getAgentDisplayName(currentAgent) : undefined;
  // The box's own words, and how many are held behind it — both read off the
  // conversation's target, which is the one place either fact lives.
  const { target } = useConversation();
  const defaultPlaceholder = target?.placeholder ?? 'Send a message...';
  const awaitingDecision = useSessionAwaitingDecision(sessionId);

  // What THIS session's runtime can do with a message sent mid-task. Steer and
  // Add context appear only when the runtime declares them (claude-code does,
  // codex and opencode do not) — a hidden choice is honest, a dead one is not.
  // A pure map lookup over the static capabilities, keyed by the session's
  // resolved runtime; `undefined` while it loads leaves both off, which is the
  // safe default.
  const sessionRuntime = useSessionRuntime(sessionId);
  const capabilities = useCapabilitiesForRuntime(sessionRuntime);
  // Steer needs BOTH answers, because the runtime's is not the whole truth: a
  // claude-code session only cuts in when it holds its agent process open
  // between messages, and a default install does not. Offering Steer on the
  // strength of the runtime flag alone promised a cut-in and delivered an
  // ordinary follow-up turn (DOR-1268). The server publishes the per-session
  // answer on the session's own status; `undefined` means it has none to give,
  // and the runtime's flag stands.
  const sessionSteerable = useSessionSteerable(sessionId);
  const canSteer = (capabilities?.supportsSteer ?? false) && (sessionSteerable ?? true);
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
    <Conversation.Composer
      // `chat-input-container` is not decoration: it is the hook for the
      // safe-area rule in `index.css`, and it rides on the card element itself.
      // The composer host never bakes it in — a session passes it, because a
      // session is the only surface that sits against the bottom of a notched
      // screen.
      className="chat-input-container"
      // A file dragged out of the Files panel is already on this machine, so it
      // becomes a reference in the message rather than an upload.
      onPathDropped={(path) => insertIntoComposer(composerFileReference(path))}
      inputRef={chatInputRef}
      value={input}
      onChange={autocomplete.handleInputChange}
      onSubmit={submitAndDismiss}
      head={
        /* Chat-only, so it arrives as a slot rather than living in the card. */
        <AnimatePresence>
          {isStreaming && (
            <ScanLine color={agentVisual.color} isTextStreaming={isTextStreaming} edge="top" />
          )}
        </AnimatePresence>
      }
      asks={
        /* `null` rather than omitted while nothing is waiting: a session CAN be
           taken over, and saying so is what lets the card animate the prompt out
           again. A channel omits the slot entirely. */
        activeInteraction ? (
          <SessionAsks
            sessionId={sessionId}
            activeInteraction={activeInteraction}
            pendingApprovals={pendingApprovals}
            focusedOptionIndex={focusedOptionIndex}
            onToolRef={onToolRef}
            onToolDecided={onToolDecided}
            // The queue panel is unmounted for the whole time a card is up (the
            // prompt replaces the entire composer), so the only mark that queued
            // messages still exist would vanish at exactly the moment it
            // reassures. The messages survive — say so.
            queueDepth={chatQueue.queue.length}
          />
        ) : null
      }
      overlays={
        <>
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
        </>
      }
      queue={
        /* The presence guard lives here, not inside the panel: a component that
           returns null is still mounted, so AnimatePresence never saw it leave
           and the panel's exit animation never ran — it popped out at the exact
           moment the last queued message flushed. */
        <AnimatePresence>
          {chatQueue.queue.length > 0 && (
            <QueuePanel
              queue={chatQueue.queue}
              editingId={chatQueue.editingId}
              onEdit={chatQueue.handleQueueEdit}
              onRemove={chatQueue.handleQueueRemove}
              onSend={chatQueue.handleQueueSend}
              onMoveUp={chatQueue.handleQueueMoveUp}
              // The server dispatches the head the moment the session frees up,
              // so the only thing that genuinely holds the line is the agent
              // parked on a person — which it will not leave until that question
              // is answered.
              statusNote={
                awaitingDecision
                  ? 'Waiting for your answer above'
                  : 'Sending one at a time as the agent finishes'
              }
            />
          )}
        </AnimatePresence>
      }
      aboveInput={<BackgroundTaskBar tasks={backgroundTasks} onStopTask={handleStopTask} />}
      footer={
        /* `asChild`, so the status line stays a direct child of the card exactly
           as it was — the serialized-DOM baseline holds it to that. */
        <Conversation.Footer asChild>
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
        </Conversation.Footer>
      }
      input={{
        isStreaming,
        commandPending,
        onStop: handleStop,
        onEscape: autocomplete.dismissPalettes,
        onClear: () => {
          setInput('');
          autocomplete.dismissPalettes();
        },
        isPaletteOpen: autocomplete.isPaletteOpen,
        paletteHasResults: autocomplete.paletteHasResults,
        onArrowUp: autocomplete.handleArrowUp,
        onArrowDown: autocomplete.handleArrowDown,
        onCommandSelect: autocomplete.handleKeyboardSelect,
        activeDescendantId: autocomplete.activeDescendantId,
        paletteListboxId: autocomplete.paletteListboxId,
        onCursorChange: autocomplete.handleCursorChange,
        // Chat is the only surface that reads this, and passing it HERE rather
        // than defaulting it inside `Composer.Input` is what keeps that true:
        // rooms, the dashboard and onboarding pass nothing, so they stay plain
        // until they graduate.
        richText: richText,
        editingQueueItem: chatQueue.editingIndex !== null,
        ...(chatQueue.editingIndex === null ? {} : { editingPosition: chatQueue.editingIndex + 1 }),
        queueDepth: chatQueue.queue.length,
        onQueue: queueAndDismiss,
        // Present ONLY when the runtime can honour them, so the composer hides
        // Steer / Add context (never greys them) on a runtime that can only
        // queue. Presence of the callback IS the capability.
        ...(canSteer ? { onSteer: steerAndDismiss } : {}),
        ...(canAddContext ? { onStage: addContextAndDismiss } : {}),
        onSaveEdit: chatQueue.handleQueueSaveEdit,
        onCancelEdit: chatQueue.handleQueueCancelEdit,
        onQueueNavigateUp: chatQueue.handleQueueNavigateUp,
        onQueueNavigateDown: chatQueue.handleQueueNavigateDown,
        queueHasItems: chatQueue.queue.length > 0,
        // The SAME key the queue and the parked draft are scoped by, so a
        // pending double-Escape dies on exactly the boundary its draft does.
        // This composer is re-rendered rather than remounted on a session
        // switch, so an arm would otherwise survive into the next session's
        // text.
        contextKey: sessionContextKey(sessionId, selectedCwd) ?? undefined,
        placeholder: getPlaceholder(
          chatQueue.editingIndex,
          isStreaming,
          chatQueue.queue.length,
          defaultPlaceholder
        ),
        placeholderOverlay: isIdle ? (
          <AnimatedPlaceholder
            text={rotatingPlaceholder.text}
            animationKey={rotatingPlaceholder.key}
          />
        ) : null,
      }}
    >
      <StopConfirmDialog
        open={stopConfirmOpen}
        onOpenChange={setStopConfirmOpen}
        queuedCount={waiting.length}
        onConfirm={confirmStop}
      />
    </Conversation.Composer>
  );
}

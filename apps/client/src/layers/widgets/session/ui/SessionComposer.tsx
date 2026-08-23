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
  type StopOutcome,
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
  /**
   * Send the composer's text into the running turn now (steer). Wired to the
   * Steer affordance only when the session's runtime declares it can take a
   * message mid-task; the affordance is hidden otherwise. Resolves `true` once
   * the server has it.
   *
   * Still a prop rather than a port method, and deliberately: `ConversationTarget`
   * has two verbs, send and queue, because those are the two every surface could
   * have. Steering is a runtime capability of ONE surface, so it stays the
   * session's own wiring — the same reason a room's rejoin button is not on the
   * port either.
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
   * Interrupt the running turn and empty its queue. Resolves with the server's
   * own verdict and the messages it took off the queue, head first, so this
   * window can return the words to the composer. See {@link StopOutcome}.
   */
  stop: () => Promise<StopOutcome>;
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

  /**
   * Hold these words for the running turn — the session's queue, reached
   * through the conversation's own port.
   *
   * The port rejects where the queue routes answer `false`, and this turns that
   * back into the boolean the funnel is built on: the composer keeps the words
   * until the server confirms it has them (DOR-480), so "did it land" has to be
   * an answer rather than an unhandled rejection.
   *
   * The missing-`queue` branch is unreachable as this ships and is a `false`
   * rather than a throw for that reason. Every session target defines `queue`
   * (its presence is what draws the queue chrome at all), and `target` itself
   * is non-null by the time anything can press a key — `Conversation.Composer`
   * refuses to render without one. It exists because the port permits a
   * queueless surface, and "the words were not taken" is the honest answer for
   * one: the composer keeps them, which is what it would do anyway.
   */
  const holdForTurn = useCallback(
    async (content: string): Promise<boolean> => {
      if (target?.queue === undefined) return false;
      try {
        await target.queue({ text: content });
        return true;
      } catch {
        return false;
      }
    },
    [target]
  );

  const chatQueue = useChatQueue({
    input,
    setInput,
    sessionId,
    selectedCwd,
    waiting,
    onEnqueue: holdForTurn,
    onSteer: steerContent,
    onStage: addContextContent,
    tryNativeCommand,
    chatInputRef,
  });

  // Stop means stop everything queued. When messages are waiting, the person is
  // asked first and told the cost, because a Stop that silently emptied a queue
  // would be a surprise; a Stop with nothing waiting skips the dialog and stops
  // immediately. Both paths end in the SAME `performStop` below, and both now
  // restore uniformly: the no-dialog path's call is a harmless no-op (nothing
  // was queued, so the server hands back nothing to restore), rather than a
  // second, asymmetric implementation of "put the words back." The words the
  // server hands back land in the composer draft, after anything already
  // typed, so nothing is lost.
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
  // A Stop that has to escalate on the server (`STOP_ACK_TIMEOUT_MS`, up to
  // ~3s) used to leave the button red and clickable for the whole wait, with
  // the fire-and-forget handler posting a fresh `/interrupt` on every extra
  // click. This is the acknowledgment: the button goes pending the instant the
  // click is heard and STAYS pending — not just for the request's own
  // round-trip — until the turn actually settles, which is what closes the
  // window a second click could race into (DOR-1300).
  //
  // Holds the SESSION the click was for, not a bare boolean. `ChatPanel`
  // re-renders this component in place across a session switch — no `key`, no
  // unmount — so a boolean pending flag survives the switch and reads as
  // "Stopping…" on a session that was never clicked, with its own Stop button
  // gone and its own click refused, until whatever session originally owned
  // the flag happens to settle. Comparing against the CURRENT `sessionId` at
  // render, every render, is what a session switch cannot race: there is no
  // window where the derived value is stale, because there is no effect
  // between the switch and the read.
  const [stopInFlightSessionId, setStopInFlightSessionId] = useState<string | null>(null);
  const stopPending = stopInFlightSessionId === sessionId && isStreaming;
  // The single-flight lock a click actually reads, mirroring the state above
  // rather than replacing it — keyed by session for the same B1 reason, but a
  // REF because a click has to read it WITHIN the current tick, before React
  // has had any chance to re-render. Two clicks landing in the same
  // synchronous turn — Radix keeps `AlertDialogAction`'s element mounted
  // through its exit animation, so nothing stops a fast double-press from
  // reaching it twice before a paint — would both read the SAME stale
  // `stopPending` closure and both pass a state-only guard; the ref is
  // written synchronously by the first click before the second one's check
  // runs, so it is what actually makes this a single-flight guard rather than
  // a single-RENDER one (DOR-1300 B2).
  const stopLockSessionIdRef = useRef<string | null>(null);
  // The turn settling — `isStreaming` flipping false — is what ends a pending
  // Stop on the happy path, and clearing the flag here (rather than only
  // relying on the comparison above) matters for a case the comparison alone
  // cannot cover: the SAME session starting a SECOND turn later. Without this,
  // `stopInFlightSessionId` would still equal `sessionId` from the first
  // Stop, and the new turn would render "Stopping…" from its very first frame.
  // Keyed on `sessionId` too, so switching sessions cannot leave this reading
  // a different session's `isStreaming` than the one it just wrote.
  const clearSettledStop = useCallback(() => {
    stopLockSessionIdRef.current = null;
    setStopInFlightSessionId(null);
  }, []);
  /* eslint-disable react-hooks/set-state-in-effect -- sync local pending flag from the external isStreaming signal (turn_end) */
  useEffect(() => {
    if (!isStreaming) clearSettledStop();
  }, [isStreaming, sessionId, clearSettledStop]);
  /* eslint-enable react-hooks/set-state-in-effect */
  // A fresh read of `isStreaming` at the moment the request settles, not the
  // value `performStop` closed over at click time — the promise can resolve
  // long after this component has re-rendered several times.
  const isStreamingRef = useRef(isStreaming);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);
  const leaveQueueForStop = chatQueue.leaveQueueForStop;
  // A fresh read of the editing cursor at the moment Stop is pressed, for the
  // same reason `isStreamingRef` exists below `performStop` reads it inside a
  // `useCallback` whose deps deliberately do not include `chatQueue` itself.
  const editingIndexRef = useRef(chatQueue.editingIndex);
  useEffect(() => {
    editingIndexRef.current = chatQueue.editingIndex;
  }, [chatQueue.editingIndex]);
  const performStop = useCallback(() => {
    // Stop cancels the WHOLE queue, including whatever item is open for edit —
    // and that item's text is already sitting in the composer as the "live"
    // edit. Left uncommitted, the cancelled message comes back from the server
    // carrying the SAME text and `restoreToComposer` appends it on top of what
    // is already there: the edited item's words, twice. Committing the edit and
    // handing the composer back its draft FIRST is what keeps the composer's
    // "existing" text (read fresh from the store below) from being the item's
    // own echo. Gated on actually editing — with nothing under edit,
    // `leaveQueueForStop` would still fire `setInput(draftRef.current)`, and an
    // untouched draft ref is `''`, silently wiping whatever the person had typed.
    if (editingIndexRef.current !== null) leaveQueueForStop();
    stopLockSessionIdRef.current = sessionId;
    setStopInFlightSessionId(sessionId);
    void stop()
      .then((outcome: StopOutcome) => {
        restoreToComposer(outcome.cancelled);
        // `ok: false` mostly means the turn had already finished on its own
        // (the server's own race note, `use-session-submit.ts`) — in which
        // case `isStreaming` has already flipped and the effect above already
        // cleared this. The case worth handling here is the other one: the
        // request genuinely failed AND the turn is still running, where
        // nothing else would ever release a pending Stop — re-enable so the
        // person can press it again instead of watching "Stopping…" forever.
        if (!outcome.ok && isStreamingRef.current) clearSettledStop();
      })
      .catch(() => {
        // The request itself never got an answer at all (network, timeout).
        // Always safe to clear: if the turn had already settled, the effect
        // above already did this and it's a no-op; if not, this is the retry
        // path.
        clearSettledStop();
      });
  }, [sessionId, stop, restoreToComposer, clearSettledStop, leaveQueueForStop]);
  const handleStop = useCallback(() => {
    // Single-flight for THIS session: a Stop already in flight cannot be
    // re-fired by a second click, Enter's Escape binding, or a rapid
    // double-press. The ref catches a same-tick double-fire the `stopPending`
    // state alone cannot (see `stopLockSessionIdRef` above); comparing it
    // against the CURRENT `sessionId`, exactly like the state, is what keeps
    // a session switch from inheriting session A's still-in-flight lock.
    if (stopLockSessionIdRef.current === sessionId || stopPending) return;
    if (waiting.length === 0) {
      performStop();
      return;
    }
    setStopConfirmOpen(true);
  }, [sessionId, stopPending, waiting.length, performStop]);
  const confirmStop = useCallback(() => {
    // Same single-flight guard as `handleStop`, for the same reason: Radix
    // keeps the confirm dialog's content mounted through its exit animation,
    // so a fast double-press on its own Stop button can reach this twice
    // before either a re-render or the dialog's own removal (DOR-1300 B2).
    if (stopLockSessionIdRef.current === sessionId || stopPending) return;
    // Pending starts HERE, on confirm — never on opening the dialog, which
    // asks a question and stops nothing yet.
    setStopConfirmOpen(false);
    performStop();
  }, [sessionId, stopPending, performStop]);

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
    // Where the session's words actually go: `ConversationTarget.send`, the
    // same port a channel's Enter ends in. Nothing is taken out of the box
    // here — the send owns the clear, and empties it only once the attachment
    // transform has succeeded (DOR-480), which is the one thing a session's
    // send does that a room's does not.
    //
    // No `.catch` here, and that is deliberate rather than an omission: the
    // session's submit turns a refused trigger into the composer's own error
    // banner (with its Retry) instead of throwing, so nothing that reaches this
    // line would be a refusal a person needs told about — it would be a bug
    // worth seeing.
    if (target === null || !target.canSend) return;
    void target.send({ text: input });
  }, [autocomplete, target, input]);

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
        stopPending,
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

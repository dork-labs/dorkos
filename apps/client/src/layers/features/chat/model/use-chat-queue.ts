import { useRef, useCallback, useEffect } from 'react';
import type { RefObject } from 'react';
import { toast } from 'sonner';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useSessionChatStore } from '@/layers/entities/session';
import { useMessageQueue } from './use-message-queue';
import type { QueueItem } from './use-message-queue';
import { isNativeCommandContent } from './native-commands';
import type { NativeCommandResult } from './native-commands';
import { sessionContextKey } from '../lib/session-context-key';
import { clearComposerOnConfirmed } from '../lib/clear-composer-on-confirmed';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import type { ComposerInputHandle } from '@/layers/features/composer';

interface UseChatQueueOptions {
  input: string;
  setInput: (value: string) => void;
  sessionId: string;
  selectedCwd: string | null;
  /** The messages genuinely waiting on this session, head first. */
  waiting: QueuedMessage[];
  /**
   * Put the composer's text on the server's queue. Resolves `true` once the
   * server has it — the composer holds the words until then, which is the whole
   * of the "nothing typed is lost" promise now that no undo handle is needed
   * (DOR-480).
   *
   * The session's host supplies its `ConversationTarget.queue` here (DOR-1354),
   * so this hook is the surface's own funnel into the port — the same role
   * `ChannelComposer.handleSubmit` plays on the way into the room target's
   * `send`. It stays a parameter because everything ABOVE the port is this
   * hook's: the native-command intercept, the duplicate-press latch, the
   * keystroke record, and the clear that waits for the server's answer.
   */
  onEnqueue: (content: string) => Promise<boolean>;
  /**
   * Send the composer's text into the running turn now (steer). Resolves `true`
   * once the server has it, exactly like {@link onEnqueue}.
   *
   * This is the DELIVERY, not the affordance, and the two are gated in different
   * places on purpose. The host passes it whenever it has one to pass; whether a
   * person is ever OFFERED a steer is decided where the button is rendered, on
   * the runtime's `supportsSteer` and — since DOR-1268 — on whether this
   * particular session can be cut into at all. Optional here only so a host with
   * no steer path at all may omit it, which leaves
   * {@link UseChatQueueReturn.handleSteer} inert.
   */
  onSteer?: (content: string) => Promise<boolean>;
  /**
   * Add the composer's text as context the agent uses next, without cutting into
   * the running turn (stage). Same shape and same split as {@link onSteer}: this
   * is the delivery, and the affordance is gated at the render site.
   */
  onStage?: (content: string) => Promise<boolean>;
  /**
   * Native (client-side) command interceptor. Checked at the queue decision so a
   * native command (e.g. `/rename`) typed while a turn streams runs instantly and
   * never enters the queue — a queued command is not words for the agent, and
   * sending it as a turn later is not what anybody meant by typing it.
   */
  tryNativeCommand: (content: string) => NativeCommandResult;
  chatInputRef: RefObject<ComposerInputHandle | null>;
}

interface UseChatQueueReturn {
  queue: QueueItem[];
  /** Id of the item under edit — what the queue panel compares against a row. */
  editingId: string | null;
  /** Position of that item, for the composer's "message 2 of 3" and for arrow-key navigation. */
  editingIndex: number | null;
  handleQueue: () => void;
  /**
   * Steer: send the composer's text into the running turn now. Inert when no
   * `onSteer` was supplied. The host decides separately whether to SHOW a Steer
   * affordance (runtime capability plus this session's own steerability), so in
   * practice this is only reachable behind one.
   */
  handleSteer: () => void;
  /** Add context: stage the composer's text for the next turn, without cutting in. */
  handleStage: () => void;
  handleQueueEdit: (id: string) => void;
  handleQueueSaveEdit: () => void;
  handleQueueCancelEdit: () => void;
  handleQueueRemove: (id: string) => void;
  /** Send one queued message next, ahead of everything else waiting. */
  handleQueueSend: (id: string) => void;
  /** Move one queued message a place earlier in the line. */
  handleQueueMoveUp: (id: string) => void;
  handleQueueNavigateUp: () => void;
  handleQueueNavigateDown: () => void;
}

/**
 * Facade hook that wraps useMessageQueue with draft-aware queue editing callbacks.
 *
 * Owns the draft ref that preserves the user's in-progress composition when they
 * navigate into the queue. Provides fully-wired callbacks for QueuePanel and Composer.Input.
 *
 * Card callbacks (`handleQueueEdit` / `handleQueueRemove` / `handleQueueSend`)
 * address a queue item by its stable id, never its position: the server
 * dispatches the head while the panel is on screen, and a second window can
 * reorder or remove a row under it, so an index captured at render time can
 * point at a different message by the time the click lands. Keyboard navigation
 * is positional by nature and resolves the position to an id at the call site.
 *
 * **Edit-in-place.** Leaving an edit by navigation — ArrowUp/Down, or clicking a
 * different row — commits the composer's current text back into the item first.
 * Before that, `startEditing` simply overwrote the composer with the next item's
 * text and the rewrite was gone with no warning (DOR-480). Only Escape discards,
 * which is what Escape is for.
 */
export function useChatQueue({
  input,
  setInput,
  sessionId,
  selectedCwd,
  waiting,
  onEnqueue,
  onSteer,
  onStage,
  tryNativeCommand,
  chatInputRef,
}: UseChatQueueOptions): UseChatQueueReturn {
  // Draft ref preserves the user's in-progress composition when they navigate into the queue
  const draftRef = useRef('');

  // The words currently making the round trip to the server's queue, or `null`.
  //
  // The composer deliberately keeps the text until the server confirms it has it
  // (DOR-480), and that reopened a double-submit the old synchronous clear used
  // to close: with the words still in the box, a second Enter during the request
  // queued the SAME message again, and the agent said it twice. Same guard the
  // composer already gives the other two Enter modes — `commandPending` for a
  // dispatched command, `!isUploading` for a send mid-upload.
  //
  // Keyed by the text rather than a plain boolean, so typing something else and
  // pressing Enter still queues: only a repeat of the message already in flight
  // is refused.
  const enqueueInFlightRef = useRef<string | null>(null);

  // The composer's context key. Everything that has to move in lockstep with the
  // editing cursor keys off this, not off `sessionId` alone: a coarser key
  // reopens the duplicate send, because a cwd-only change would reset the cursor
  // while leaving the queued item's body in the composer, indistinguishable from
  // a draft (DOR-480).
  const contextKey = sessionContextKey(sessionId, selectedCwd);

  // The draft is context-scoped: clear it on a switch so a composition parked
  // while editing session A's queue can never be restored into session B's input
  // (DOR-81 cross-session-leak class; the queue itself is per session on the
  // server, and each window only ever watches one).
  useEffect(() => {
    draftRef.current = '';
    enqueueInFlightRef.current = null;
  }, [contextKey]);

  const messageQueue = useMessageQueue({ sessionId, waiting, onEnqueue });

  // A session switch drops the editing cursor along with the draft: the cursor
  // names a message on the OUTGOING session's queue, and leaving it set would
  // point the composer at a row the incoming session does not have.
  const cancelEditing = messageQueue.cancelEditing;
  useEffect(() => {
    cancelEditing();
  }, [contextKey, cancelEditing]);

  /**
   * Commit the composer's current text into the item under edit WITHOUT moving
   * the cursor — the write half of edit-in-place. An emptied composer is not a
   * delete: the item keeps the content it had.
   *
   * Unlike {@link handleQueueSaveEdit} this does NOT run a native command — it
   * commits one into the queue and says so. Running `/clear` because someone
   * pressed ArrowUp would be a genuine surprise, and refusing would silently
   * discard the rewrite, which is the very loss edit-in-place exists to prevent.
   * But it is not obvious — the row quietly becomes something that will FIRE
   * rather than send — so it gets a toast, since navigating away carries no
   * other signal the way pressing Enter does.
   */
  const commitEditInPlace = useCallback(() => {
    const editingId = messageQueue.editingId;
    if (editingId === null) return;
    const trimmed = input.trim();
    if (!trimmed) return;
    messageQueue.updateQueued(editingId, trimmed);
    if (isNativeCommandContent(trimmed)) {
      toast.warning('Saved as a command — it will run, not send, when its turn comes');
    }
  }, [input, messageQueue]);

  // Context-switch handoff (DOR-480). The editing cursor is component state
  // while the composer text lives in the per-session chat store, so switching
  // away mid-edit left the OUTGOING session's composer holding a queued item's
  // body with no cursor to explain it — indistinguishable from an ordinary
  // draft. Hand the session back the way it was left: commit the edit into its
  // queue, and put its parked draft back in its composer.
  //
  // Keyed on `contextKey`, so a cwd-only change — which resets the cursor just
  // the same — gets the identical handoff rather than leaving the item's body
  // behind.
  // Latest-value refs: the cleanup below runs AFTER the switch render, when this
  // state still holds the OUTGOING context's cursor.
  const editingIdRef = useRef<string | null>(null);
  editingIdRef.current = messageQueue.editingId;
  const commitOutgoingRef = useRef(messageQueue.updateQueued);
  commitOutgoingRef.current = messageQueue.updateQueued;

  useEffect(() => {
    const outgoingSessionId = sessionId;
    return () => {
      const editingId = editingIdRef.current;
      if (editingId === null || !outgoingSessionId) return;
      // Read the outgoing session's own composer text from the store — `input`
      // in this closure is already the INCOMING session's, because both come
      // from the same session-keyed store re-read under the new key.
      const chatStore = useSessionChatStore.getState();
      const composed = chatStore.getSession(outgoingSessionId).input.trim();
      if (composed) commitOutgoingRef.current(editingId, composed);
      chatStore.updateSession(outgoingSessionId, { input: draftRef.current });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `contextKey` IS (sessionId, cwd); listing sessionId too would re-run this on nothing new
  }, [contextKey]);

  // Deliver the composer's text to a working session — queue, steer, or add
  // context — through one flow, because the three differ only in `run`. The
  // native-command intercept, the duplicate-send latch, the keystroke record,
  // and the "hold the words until the server has them" clear are identical for
  // all three: a `/rename` typed mid-stream runs instantly whichever verb was
  // pressed, and steering or staging is as much an operator act as queueing.
  const deliver = useCallback(
    (run: (content: string) => Promise<boolean>) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      // A native command must run instantly (even mid-stream) and must never
      // reach the agent as a message. Clear the composer only when it actually
      // ran — a rejected command keeps its text.
      const native = tryNativeCommand(trimmed);
      if (native.handled) {
        if (!native.ran) return;
        // `ran` is only "the dispatch started" for a command that finishes
        // asynchronously. `/compact <instructions>` typed mid-stream is exactly
        // that, so settle the clear on the same signal the delivery settles on.
        if (native.confirmed) {
          clearComposerOnConfirmed(sessionId, trimmed, native.confirmed);
        } else {
          setInput('');
        }
        return;
      }
      // These exact words are already on their way; a second press must not send
      // them again. See {@link enqueueInFlightRef}.
      if (enqueueInFlightRef.current === trimmed) return;
      enqueueInFlightRef.current = trimmed;
      // **Delivered at the KEYSTROKE, and recorded at the keystroke — the only
      // instant in this message's life that belongs to the operator** (DOR-1156).
      //
      // Nothing records when the message is finally said. The SERVER dispatches
      // the queue now (`persistent-session-runtime`), and it dispatches when the
      // running turn ends — the agent's moment, not the person's. A record made
      // then would time this row's place in Today to the instant an agent stopped
      // talking, which is the one thing BC-16 forbids: "a `session_status` event,
      // a tool call or an agent's post changes nothing here, because none of them
      // is an input." Pressing the key is the submission; what happens afterwards
      // is the system's business.
      //
      // Below the duplicate-send latch on purpose. `recordOpened` advances a use
      // COUNT as well as an instant (P3.3), so recording above the latch would
      // rank a conversation by how impatient somebody was with one message.
      useInteractionStore.getState().recordOpened('session', sessionId);
      if (selectedCwd) useInteractionStore.getState().recordOpened('agent', selectedCwd);
      // The composer keeps the words until the server has them. That is the whole
      // of "nothing typed is ever lost" now: the old queue dequeued optimistically
      // and needed an undo handle for every refusal path (DOR-480), and a message
      // that was never taken out of the composer cannot fail to be put back.
      const accepted = run(trimmed);
      void accepted.finally(() => {
        // Only clear the latch this call set — a newer delivery owns it now.
        if (enqueueInFlightRef.current === trimmed) enqueueInFlightRef.current = null;
      });
      clearComposerOnConfirmed(sessionId, trimmed, accepted);
    },
    [input, selectedCwd, sessionId, setInput, tryNativeCommand]
  );

  const handleQueue = useCallback(
    () => deliver((content) => messageQueue.addToQueue(content)),
    [deliver, messageQueue]
  );

  // Steer and Add context are inert unless the host wired their delivery — which
  // it does exactly when the session's runtime declares the capability, so a
  // no-op here means the affordance was never offered in the first place.
  const handleSteer = useCallback(() => {
    if (onSteer) deliver(onSteer);
  }, [deliver, onSteer]);

  const handleStage = useCallback(() => {
    if (onStage) deliver(onStage);
  }, [deliver, onStage]);

  const handleQueueEdit = useCallback(
    (id: string) => {
      // Clicking the row already under edit must not reload it — that would
      // overwrite the composer with the stored text and lose the rewrite.
      if (messageQueue.editingId === id) {
        chatInputRef.current?.focus();
        return;
      }
      const wasEditing = messageQueue.editingId !== null;
      // Moving to another row commits the row being left (edit-in-place).
      if (wasEditing) commitEditInPlace();
      // `null` means the item was dispatched or removed between render and click
      // — leave the composer exactly as the user left it.
      const content = messageQueue.startEditing(id);
      if (content === null) return;
      if (!wasEditing) draftRef.current = input;
      setInput(content);
      chatInputRef.current?.focus();
    },
    [input, messageQueue, commitEditInPlace, setInput, chatInputRef]
  );

  const handleQueueSaveEdit = useCallback(() => {
    if (messageQueue.editingId === null) return;
    const trimmed = input.trim();
    if (!trimmed) return;
    // A command must not enter the queue: it is not words for the agent, and an
    // edit that turns a message into a command means the same thing an enqueue
    // does, so it gets the same treatment. Refusing looked safer and was a dead
    // end: Escape swaps in the parked draft (losing the command that was just
    // typed) and every corrected form was refused again, so the only exits
    // destroyed text (DOR-480). Uses `tryNativeCommand` — the funnel's own
    // recognizer — because it catches the runtime-fulfilled `/compact` intent
    // that the client-native parser deliberately skips.
    const native = tryNativeCommand(trimmed);
    if (native.handled) {
      // It ran: the queued row keeps the content it already had, and the edit is
      // over. A REJECTED command keeps its text and the cursor, so it can be
      // fixed in place and re-submitted — the recovery that used to not exist.
      if (native.ran) {
        messageQueue.cancelEditing();
        setInput(draftRef.current);
      }
      return;
    }
    messageQueue.saveEditing(trimmed);
    setInput(draftRef.current);
  }, [input, messageQueue, setInput, tryNativeCommand]);

  const handleQueueCancelEdit = useCallback(() => {
    messageQueue.cancelEditing();
    setInput(draftRef.current);
  }, [messageQueue, setInput]);

  const handleQueueRemove = useCallback(
    (id: string) => {
      if (messageQueue.editingId === id) {
        setInput(draftRef.current);
      }
      messageQueue.removeFromQueue(id);
    },
    [messageQueue, setInput]
  );

  const handleQueueSend = useCallback(
    (id: string) => {
      // Sending the row under edit sends the REWRITE, not the stored text.
      // Committing first is safe whether or not the move happens — it is the
      // same write navigating away would do, and it no-ops on an id that already
      // left the queue.
      const editingThisRow = messageQueue.editingId === id;
      if (editingThisRow) commitEditInPlace();
      // The composer is only swapped for a move that ACTUALLY happened. Doing it
      // unconditionally left the parked draft in the box on a refused send while
      // the cursor still pointed at the row — and the next Enter routes to
      // onSaveEdit, writing that draft over the rewrite (DOR-480).
      const moved = messageQueue.sendNow(id);
      if (moved && editingThisRow) setInput(draftRef.current);
    },
    [messageQueue, commitEditInPlace, setInput]
  );

  const handleQueueMoveUp = useCallback(
    (id: string) => {
      messageQueue.moveUp(id);
    },
    [messageQueue]
  );

  /** Moves the editing cursor to a position, restoring the draft if it falls off the queue. */
  const editAtPosition = useCallback(
    (index: number) => {
      const id = messageQueue.queue[index]?.id;
      if (id !== undefined && id === messageQueue.editingId) return;
      commitEditInPlace();
      const content = id === undefined ? null : messageQueue.startEditing(id);
      if (content === null) {
        messageQueue.cancelEditing();
        setInput(draftRef.current);
        return;
      }
      setInput(content);
    },
    [messageQueue, commitEditInPlace, setInput]
  );

  /** Leaves the queue entirely: commits the edit, then hands the draft back. */
  const leaveQueue = useCallback(() => {
    commitEditInPlace();
    messageQueue.cancelEditing();
    setInput(draftRef.current);
  }, [commitEditInPlace, messageQueue, setInput]);

  const handleQueueNavigateUp = useCallback(() => {
    const { editingIndex, queue } = messageQueue;
    if (editingIndex === null) {
      if (queue.length === 0) return;
      draftRef.current = input;
      editAtPosition(queue.length - 1);
    } else if (editingIndex > 0) {
      editAtPosition(editingIndex - 1);
    } else {
      leaveQueue();
    }
  }, [editAtPosition, input, leaveQueue, messageQueue]);

  const handleQueueNavigateDown = useCallback(() => {
    const { editingIndex, queue } = messageQueue;
    if (editingIndex === null) return;
    if (editingIndex < queue.length - 1) {
      editAtPosition(editingIndex + 1);
    } else {
      leaveQueue();
    }
  }, [editAtPosition, leaveQueue, messageQueue]);

  return {
    queue: messageQueue.queue,
    editingId: messageQueue.editingId,
    editingIndex: messageQueue.editingIndex,
    handleQueue,
    handleSteer,
    handleStage,
    handleQueueEdit,
    handleQueueSaveEdit,
    handleQueueCancelEdit,
    handleQueueRemove,
    handleQueueSend,
    handleQueueMoveUp,
    handleQueueNavigateUp,
    handleQueueNavigateDown,
  };
}

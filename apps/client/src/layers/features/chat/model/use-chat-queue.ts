import { useRef, useCallback, useEffect } from 'react';
import type { RefObject } from 'react';
import { toast } from 'sonner';
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
   */
  onEnqueue: (content: string) => Promise<boolean>;
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

  const handleQueue = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    // A native command must run instantly (even mid-stream) and must never enter
    // the queue. Clear the composer only when it actually ran — a rejected
    // command keeps its text.
    const native = tryNativeCommand(trimmed);
    if (native.handled) {
      if (!native.ran) return;
      // `ran` is only "the dispatch started" for a command that finishes
      // asynchronously. `/compact <instructions>` typed mid-stream is exactly
      // that, so settle the clear on the same signal the enqueue settles on.
      if (native.confirmed) {
        clearComposerOnConfirmed(sessionId, trimmed, native.confirmed);
      } else {
        setInput('');
      }
      return;
    }
    // These exact words are already on their way; a second Enter must not send
    // them again. See {@link enqueueInFlightRef}.
    if (enqueueInFlightRef.current === trimmed) return;
    enqueueInFlightRef.current = trimmed;
    // The composer keeps the words until the server has them. That is the whole
    // of "nothing typed is ever lost" now: the old queue dequeued optimistically
    // and needed an undo handle for every refusal path (DOR-480), and a message
    // that was never taken out of the composer cannot fail to be put back.
    const accepted = messageQueue.addToQueue(trimmed);
    void accepted.finally(() => {
      // Only clear the latch this call set — a newer enqueue owns it now.
      if (enqueueInFlightRef.current === trimmed) enqueueInFlightRef.current = null;
    });
    clearComposerOnConfirmed(sessionId, trimmed, accepted);
  }, [input, messageQueue, sessionId, setInput, tryNativeCommand]);

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

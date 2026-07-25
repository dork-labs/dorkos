import { useRef, useCallback, useEffect } from 'react';
import type { RefObject } from 'react';
import { toast } from 'sonner';
import { useSessionChatStore, useSessionStreamStore } from '@/layers/entities/session';
import { useMessageQueue } from './use-message-queue';
import type { QueueItem, QueueFlushOptions } from './use-message-queue';
import { parseNativeCommand } from './native-commands';
import type { NativeCommandResult } from './native-commands';
import type { ChatStatus } from './chat-types';
import type { ChatInputHandle } from '../ui/input/ChatInput';

interface UseChatQueueOptions {
  input: string;
  setInput: (value: string) => void;
  status: ChatStatus;
  sessionBusy: boolean;
  sessionId: string;
  selectedCwd: string | null;
  /**
   * Flush callback. Receives the pristine message, its origin session id (so the
   * submit path can refuse a cross-session flush — DOR-81), and the flush options
   * carrying the queue origin plus the restore handle out-of-band. Wired to
   * `submitContent`.
   */
  onFlush: (content: string, originSessionId: string, opts: QueueFlushOptions) => void;
  /**
   * Native (client-side) command interceptor. Checked at the queue decision so a
   * native command (e.g. `/rename`) typed while a turn streams runs instantly and
   * never enters the queue — a queued native command flushes without starting a
   * turn, so it would break the streaming→idle flush pump and silently stall
   * every message queued behind it.
   */
  tryNativeCommand: (content: string) => NativeCommandResult;
  chatInputRef: RefObject<ChatInputHandle | null>;
}

interface UseChatQueueReturn {
  queue: QueueItem[];
  editingIndex: number | null;
  /** Why Send-now is unavailable right now, or `null` when it will work. */
  sendBlockedReason: string | null;
  handleQueue: () => void;
  handleQueueEdit: (id: string) => void;
  handleQueueSaveEdit: () => void;
  handleQueueCancelEdit: () => void;
  handleQueueRemove: (id: string) => void;
  /** Send one queued message immediately, ahead of the auto-flush pump. */
  handleQueueSend: (id: string) => void;
  handleQueueNavigateUp: () => void;
  handleQueueNavigateDown: () => void;
}

/**
 * Facade hook that wraps useMessageQueue with draft-aware queue editing callbacks.
 *
 * Owns the draft ref that preserves the user's in-progress composition when they
 * navigate into the queue. Provides fully-wired callbacks for QueuePanel and ChatInput.
 *
 * Card callbacks (`handleQueueEdit` / `handleQueueRemove` / `handleQueueSend`)
 * address a queue item by its stable id, never its position: the auto-flush
 * dequeues the head while the panel is on screen, so an index captured at render
 * time can point at a different message by the time the click lands. Keyboard
 * navigation is positional by nature and resolves the position to an id at the
 * call site.
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
  status,
  sessionBusy,
  sessionId,
  selectedCwd,
  onFlush,
  tryNativeCommand,
  chatInputRef,
}: UseChatQueueOptions): UseChatQueueReturn {
  // Draft ref preserves the user's in-progress composition when they navigate into the queue
  const draftRef = useRef('');

  // The composer's context key: EXACTLY the `(sessionId, cwd)` pair
  // `useMessageQueue` scopes the editing cursor to (see its own note on why a
  // space is a safe delimiter for a UUID-prefixed key). Everything that has to
  // move in lockstep with that cursor keys off this, not off `sessionId` alone —
  // a coarser key reopens the duplicate send, because a cwd-only change would
  // reset the cursor while leaving the queued item's body sitting in the
  // composer, indistinguishable from a draft (DOR-480).
  const contextKey = `${sessionId} ${selectedCwd ?? ''}`;

  // The draft is context-scoped: clear it on a switch so a composition parked
  // while editing session A's queue can never be restored into session B's input
  // (DOR-81 cross-session-leak class; the queue itself is already store-keyed).
  useEffect(() => {
    draftRef.current = '';
  }, [contextKey]);

  const messageQueue = useMessageQueue({
    status,
    sessionBusy,
    sessionId,
    selectedCwd,
    onFlush,
  });

  /**
   * Commit the composer's current text into the item under edit WITHOUT moving
   * the cursor — the write half of edit-in-place. An emptied composer is not a
   * delete: the item keeps the content it had.
   *
   * Unlike {@link handleQueueSaveEdit} this does NOT refuse a native command.
   * Refusing here would silently discard the rewrite, which is the very loss
   * edit-in-place exists to prevent — and it is safe to accept one, because a
   * queued native command that gets rejected at flush time is now restored to the
   * queue rather than destroyed (DOR-480), and one that runs is recoverable with
   * the row's Send-now control. Saving is an explicit "commit this"; navigating
   * away is not, so only the explicit one is worth interrupting.
   */
  const commitEditInPlace = useCallback(() => {
    const editingId = messageQueue.editingId;
    if (editingId === null) return;
    const trimmed = input.trim();
    if (trimmed) messageQueue.updateQueued(editingId, trimmed);
  }, [input, messageQueue]);

  // Context-switch handoff (DOR-480). The editing cursor is component state
  // while the composer text lives in the per-session chat store, so switching
  // away mid-edit left the OUTGOING session's composer holding a queued item's
  // body with no cursor to explain it — indistinguishable from an ordinary
  // draft. Coming back and pressing Enter sent a duplicate of a message that was
  // still queued and would flush again. Hand the session back the way it was
  // left: commit the edit into its queue, and put its parked draft back in its
  // composer.
  //
  // Keyed on `contextKey`, so a cwd-only change — which resets the cursor just
  // the same — gets the identical handoff rather than leaving the item's body
  // behind. `switch-agent-cwd.ts` sets cwd and then navigates, one un-batched
  // render apart, so this is a render ordering away from live.
  // Latest-value ref: the cleanup below runs AFTER the switch render, when this
  // state still holds the OUTGOING context's cursor.
  const editingIdRef = useRef<string | null>(null);
  editingIdRef.current = messageQueue.editingId;

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
      if (composed) {
        useSessionStreamStore
          .getState()
          .updateQueuedMessage(outgoingSessionId, editingId, composed);
      }
      chatStore.updateSession(outgoingSessionId, { input: draftRef.current });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `contextKey` IS (sessionId, cwd); listing sessionId too would re-run this on nothing new
  }, [contextKey]);

  const handleQueue = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    // A native command must run instantly (even mid-stream) and must never enter
    // the queue: a queued native command flushes without starting a turn, which
    // breaks the streaming→idle flush pump and stalls everything behind it. Clear
    // the composer only when it actually ran — a rejected command keeps its text.
    const native = tryNativeCommand(trimmed);
    if (native.handled) {
      if (native.ran) setInput('');
      return;
    }
    messageQueue.addToQueue(trimmed);
    setInput('');
  }, [input, messageQueue, setInput, tryNativeCommand]);

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
      // `null` means the item was flushed or removed between render and click —
      // leave the composer exactly as the user left it.
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
    // `handleQueue` keeps native commands out of the queue at enqueue time, but
    // an edit can rewrite a queued message INTO one and reach the queue by the
    // back door — and a queued native command flushes without starting a turn,
    // so the streaming→idle pump never re-arms and everything behind it waits.
    // Refuse the save and keep the composer text exactly as typed; the operator
    // can run it with Escape-then-Enter or correct it in place. Parsed, never
    // executed: saving an edit must not fire `/clear` as a side effect.
    if (parseNativeCommand(trimmed)) {
      toast.error('A command like this runs right away — it cannot wait in the queue');
      return;
    }
    messageQueue.saveEditing(trimmed);
    setInput(draftRef.current);
  }, [input, messageQueue, setInput]);

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
      // Committing first is safe whether or not the send happens — it is the
      // same write navigating away would do, and it no-ops on an id that already
      // left the queue.
      const editingThisRow = messageQueue.editingId === id;
      if (editingThisRow) commitEditInPlace();
      // The composer is only swapped for a send that ACTUALLY happened. Doing it
      // unconditionally left the parked draft in the box on a refused send while
      // the cursor still pointed at the row — and the next Enter routes to
      // onSaveEdit, writing that draft over the rewrite (DOR-480).
      const delivered = messageQueue.sendNow(id);
      if (delivered && editingThisRow) setInput(draftRef.current);
    },
    [messageQueue, commitEditInPlace, setInput]
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
    editingIndex: messageQueue.editingIndex,
    sendBlockedReason: messageQueue.sendBlockedReason,
    handleQueue,
    handleQueueEdit,
    handleQueueSaveEdit,
    handleQueueCancelEdit,
    handleQueueRemove,
    handleQueueSend,
    handleQueueNavigateUp,
    handleQueueNavigateDown,
  };
}
